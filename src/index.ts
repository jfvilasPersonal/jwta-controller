import express from 'express';
import bodyParser from 'body-parser';
import * as k8s from '@kubernetes/client-node';
import { NetworkingV1Api, CoreV1Api, AppsV1Api, CustomObjectsApi, RbacAuthorizationV1Api, V1ServiceAccount } from '@kubernetes/client-node';
import { VERSION } from './version';

// Configures connection to the Kubernetes cluster
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
var logLevel=0;
var enableConsole=false;

// Create the kubernetes clients
const coreApi = kc.makeApiClient(CoreV1Api);
const networkingApi = kc.makeApiClient(NetworkingV1Api);
const appsApi = kc.makeApiClient(AppsV1Api);
const crdApi = kc.makeApiClient(CustomObjectsApi);
const rbacApi = kc.makeApiClient(RbacAuthorizationV1Api);


async function createRole (authorizatorName:string, namespace:string) {
  var role:any = {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: {
      name: `obk-authorizator-${authorizatorName}-role`
    },
    rules: [
      { apiGroups: [ '' ], resources: [ 'secrets' ], verbs: [ 'get', 'add', 'update' ] }
    ]
  };
  await rbacApi.createNamespacedRole(namespace, role);
}

async function createRoleBinding (authorizatorName:string, namespace:string) {
  var roleBinding:any = {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: {
      name: `obk-authorizator-${authorizatorName}-rolebinding`
    },
    subjects: [
      { kind: 'ServiceAccount', name: `obk-authorizator-${authorizatorName}-sa`, namespace: namespace}
    ],
    roleRef: {
      kind: 'Role',
      name: `obk-authorizator-${authorizatorName}-role`
    }
    
  };
  await rbacApi.createNamespacedRoleBinding(namespace,roleBinding);
}

async function createServiceAccount (authorizatorName:string, namespace:string) {
  const serviceAccount: V1ServiceAccount = {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: {
        name: `obk-authorizator-${authorizatorName}-sa`
    }
};  
  await coreApi.createNamespacedServiceAccount(namespace,serviceAccount);
}


async function checkIngress (name:any,namespace:any,ingressClassName:any) {
  //+++ Check that ingress do exist with specified CLASS NAME
  try {
    var ing = await networkingApi.readNamespacedIngress(name, namespace);
    log(1,ing);
  }
  catch (err: any) {
    if (err.statusCode===404)
      log(0,"Error, inexistent ingress: "+name);
    else {
      log(0,"Error checking ingress");
      log(0,err);
    }
    return false;
  }
  return true;  
}


//+++ Traefik middleware is under development
async function createTraefikMiddleware(authorizatorName:string,authorizatorNamespace:string,clusterName:string,spec:any) {
  // +++ create a CRD resource
  /*
  apiVersion: traefik.io/v1alpha1
  kind: Middleware
  metadata:
    name: testauth
    namespace: dev
  spec:
    forwardAuth:
      address: http://.....
  */
  var address=`http://obk-authorizator-${authorizatorName}-svc.${authorizatorNamespace}.svc.${clusterName}:3882/validate/${authorizatorName}`;
  var resource = {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'Middleware',
    metadata: {
      name: `obk-traefik-middleware-${authorizatorName}`,
      namespace: authorizatorNamespace
    },
    spec: {
      forwardAuth: {
        address: address
      }
    }
  }
  log(2, 'Creating traefik middleware: ');
  log(2, resource);
  await crdApi.createNamespacedCustomObject('traefik.io', 'v1alpha1', authorizatorNamespace, 'middlewares', resource); 
}


async function annotateIngress(authorizatorName:string,authorizatorNamespace:string,clusterName:string, spec:any) {
    // +++ we need to decide how to manage shared authorizators

    /* NGINX Ingress
    nginx.org/location-snippets: |
      auth_request /auth;
    nginx.org/server-snippets: |
      location = /auth {
        proxy_pass http://clusterdns:port/validate/ingressname;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header X-Original-URI $request_uri;
      }
    */
    log(1,'Annotating ingress '+spec.ingress.name+' of provider '+spec.ingress.provider);
    const response2 = await networkingApi.readNamespacedIngress(spec.ingress.name, authorizatorNamespace);
    var ingressObject:any = response2.body;

    switch(spec.ingress.provider) {
      case 'ingress-nginx':
        ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-url'] = `http://obk-authorizator-${authorizatorName}-svc.${authorizatorNamespace}.svc.${clusterName}:3882/validate/${authorizatorName}`;
        ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-method'] = 'GET';
        ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-response-headers'] = 'WWW-Authenticate';
        break;
      case 'nginx-ingress':
        //var headersSnippet = 'sssss';
        var locationSnippet = 'auth_request /obk-auth;';
        var serverSnippet = `location = /obk-auth { proxy_pass http://obk-authorizator-${authorizatorName}-svc.${authorizatorNamespace}.svc.${clusterName}:3882/validate/${authorizatorName}; proxy_pass_request_body off; proxy_set_header Content-Length ""; proxy_set_header X-Original-URI $request_uri; }`;
        ingressObject.metadata.annotations['nginx.org/location-snippets'] = locationSnippet;
        ingressObject.metadata.annotations['nginx.org/server-snippets'] = serverSnippet;
        break;
      case 'haproxy':
        log (0,'HAProxy ingress still not supported... we are working hard!');
        break;
      case 'traefik':
        await createTraefikMiddleware(authorizatorName, authorizatorNamespace, clusterName, spec);
        ingressObject.metadata.annotations['traefik.ingress.kubernetes.io/router.middlewares'] = `${authorizatorNamespace}-obk-traefik-middleware-${authorizatorName}@kubernetescrd`;
        break;
      default:
        log (0,'Invalid ingress provider to annotate');
        break;
    }

    await networkingApi.replaceNamespacedIngress(spec.ingress.name, authorizatorNamespace, ingressObject);
    log(1,'Ingress annotated');
}


async function createObkAuthorizator (authorizatorName:string,authorizatorNamespace:string,spec:any) {
  //create deployment
  log(1,'Creating Deployment');
  var deploymentName = 'obk-authorizator-'+authorizatorName+'-deply';

  try {
    var appName='obk-authorizator-'+authorizatorName+'-listener';

    // Create the spec fo the deployment
    const deploymentSpec = {
      replicas: spec.config.replicas,
      selector: { matchLabels: { app: appName } },
      template: {
        metadata: { 
          labels: { app: appName },
          annotations: {
            'oberkorn.jfvilas.at.outlook.com/ingress': spec.ingress.name,
            'oberkorn.jfvilas.at.outlook.com/authorizator': authorizatorName,
            'oberkorn.jfvilas.at.outlook.com/namespace': authorizatorNamespace
          }
        },
        spec: {
          serviceAccountName: `obk-authorizator-${authorizatorName}-sa`,
          containers: [
            {
              name: appName,
              image: 'obk-authorizator',
              ports: [ {containerPort:3882, protocol:'TCP'} ],
              env: [
                { name: 'OBKA_NAME', value: authorizatorName},
                { name: 'OBKA_NAMESPACE', value: authorizatorNamespace},
                { name: 'OBKA_RULESETS', value:JSON.stringify(spec.rulesets)},
                { name: 'OBKA_VALIDATORS', value:JSON.stringify(spec.validators)},
                { name: 'OBKA_API', value:JSON.stringify(spec.config.api)},
                { name: 'OBKA_PROMETHEUS', value:JSON.stringify(spec.config.prometheus)},
                { name: 'OBKA_LOG_LEVEL', value:JSON.stringify(spec.config.logLevel)}
              ],
              imagePullPolicy: 'Never'   //+++ this is a specific requirement of K3D
            },
          ]
        },
      },
      strategy: {
        type: 'RollingUpdate',
        rollingUpdate: {
          maxSurge: 1,
          maxUnavailable: 0
        }
      }
    };

    // create a Deployment object
    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: deploymentName,
        namespace: authorizatorNamespace
      },
      spec: deploymentSpec,
    };

    // Create the Deployment in the cluster
    await appsApi.createNamespacedDeployment(authorizatorNamespace, deployment);
    log(1,'Deployment successfully created');

    // Create a Service
    log(1,'Creting service service');
    var serviceName='obk-authorizator-'+authorizatorName+'-svc';
    var serviceBody:k8s.V1Service = new k8s.V1Service();
    serviceBody= {
      apiVersion: "v1",
      metadata: {
        name: serviceName,
        namespace: authorizatorNamespace
      },
      spec: {
        ports: [ { protocol: 'TCP', port: 3882, targetPort: 3882 } ],
        selector: { app: appName },
        type: 'ClusterIP'
      }
    }

    await coreApi.createNamespacedService(authorizatorNamespace, serviceBody);
    log(1,'Service created succesfully');

    await annotateIngress(authorizatorName, authorizatorNamespace, 'cluster.local', spec);

    // create service account
    log(1,'Creating SA');
    await createServiceAccount(authorizatorName, authorizatorNamespace);
    log(1,'SA created succesfully');

    // create role
    log(1,'Creating Role');
    await createRole(authorizatorName, authorizatorNamespace);
    log(1,'Role created succesfully');

    // create role binding
    log(1,'Creating RoleBinding');
    await createRoleBinding(authorizatorName, authorizatorNamespace);
    log(1,'RoleBinding created succesfully');
  }
  catch (err) {
    log(0,'Error  creating the ObkAuthorizator');
    log(0,err);
  }              
}


async function processAdd(authorizatorObject: any) {
  var namespace=authorizatorObject.metadata.namespace;
  if (namespace===undefined) namespace='default';
  var ingress=authorizatorObject.spec.ingress;
  if (! (await checkIngress(ingress.name, namespace, ingress.class))) {
    log(0,"Ingress validation failed");
    return false;
  }
  createObkAuthorizator(authorizatorObject.metadata.name, namespace, authorizatorObject.spec);
  return true;
}


async function deleteObkAuthorizator (authorizatorName:string,authorizatorNamespace:string, spec:any) {
  try {
    var deploymentName = 'obk-authorizator-'+authorizatorName+'-deply';
    var depResp= await appsApi.readNamespacedDeployment(deploymentName, authorizatorNamespace);
    var deployment=depResp.body;
    var ingressName=(deployment.spec?.template?.metadata?.annotations as any)['oberkorn.jfvilas.at.outlook.com/ingress'];

    //delete deployment
    var response = await appsApi.deleteNamespacedDeployment(deploymentName,authorizatorNamespace);
    log(1,`Deployment ${deploymentName} successfully removed`);

    //delete service
    var servName = 'obk-authorizator-'+authorizatorName+'-svc';
    const respServ = await coreApi.deleteNamespacedService(servName, authorizatorNamespace);
    log(1,`Service ${servName} successfully removed`);

    // de-annotate ingress
    log(1,'De-annotating ingress '+ingressName);
      const ingressResponse = await networkingApi.readNamespacedIngress(ingressName, authorizatorNamespace);
      var ingressObject:any = ingressResponse.body;

      switch(spec.ingress.provider) {
        case 'ingress-nginx':
          if (ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-url']) delete ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-url'];
          if (ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-method']) delete ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-method'];
          break;

        case 'nginx-ingress':
          if (ingressObject.metadata.annotations['nginx.org/location-snippets']) delete ingressObject.metadata.annotations['nginx.org/location-snippets'];
          if (ingressObject.metadata.annotations['nginx.org/server-snippets']) delete ingressObject.metadata.annotations['nginx.org/server-snippets'];
          break;
    
        case 'traefik':
          var name = `obk-traefik-middleware-${authorizatorName}`;
          await crdApi.deleteNamespacedCustomObject('traefik.io', 'v1alpha1', authorizatorNamespace, 'middlewares', name);        
          break;
      }
      await networkingApi.replaceNamespacedIngress(ingressName, authorizatorNamespace, ingressObject);
      log(1,'Ingress updated');

    //delete service account
    log(1,`Removing SA`);
    const respSA = await coreApi.deleteNamespacedServiceAccount(`obk-authorizator-${authorizatorName}-sa`, authorizatorNamespace);
    log(1,`SA successfully removed`);

    //delete role
    log(1,`Removing Role`);
    const respRole = await rbacApi.deleteNamespacedRole(`obk-authorizator-${authorizatorName}-role`, authorizatorNamespace);
    log(1,`Role successfully removed`);

    //delete rolebinsing
    log(1,`Removing RoleBinding`);
    const respRoleBinding = await rbacApi.deleteNamespacedRoleBinding(`obk-authorizator-${authorizatorName}-rolebinding`, authorizatorNamespace);
    log(1,`RoleBinding successfully removed`);

  }
  catch (err) {
    if ((err as any).statusCode===404) {
      log(0,`WARNING, ObkAuthorizator ${authorizatorName} doesn't exist.`);
    }
    else {
      log(0,'Error removing ObkAuthorizator');
      log(0,err);
    }
  }
}


async function processDelete(authorizatorObject:any) {
  var ns=authorizatorObject.metadata.namespace;
  if (ns===undefined) ns='default';

  await deleteObkAuthorizator(authorizatorObject.metadata.name, ns, authorizatorObject.spec);
}


async function modifyObkAuthorizator (authorizatorName:string,authorizatorNamespace:string,spec:any) {
  // modify the Deployment
  log(1,'Modifying Deployment');
  var deploymentName = 'obk-authorizator-'+authorizatorName+'-deply';

  try {
    var appName="obk-authorizator-"+authorizatorName+"-listener";

    // Create the spec
    const deploymentSpec = {
      replicas: spec.config.replicas,
      selector: { matchLabels: { app: appName } },
      template: {
        metadata: { 
          labels: { app: appName },
          annotations: {
            'oberkorn.jfvilas.at.outlook.com/ingress': spec.ingress.name,
            'oberkorn.jfvilas.at.outlook.com/authorizator': authorizatorName,
            'oberkorn.jfvilas.at.outlook.com/namespace': authorizatorNamespace
          }
        },
        spec: {
          containers: [
            {
              name: appName,
              image: 'obk-authorizator',
              ports: [ {containerPort:3882, protocol:'TCP'} ],
              env: [ 
                { name: 'OBKA_NAME', value: authorizatorName},
                { name: 'OBKA_NAMESPACE', value: authorizatorNamespace},
                { name: 'OBKA_RULESETS', value:JSON.stringify(spec.rulesets)},
                { name: 'OBKA_VALIDATORS', value:JSON.stringify(spec.validators)},
                { name: 'OBKA_API', value:JSON.stringify(spec.config.api)},
                { name: 'OBKA_PROMETHEUS', value:JSON.stringify(spec.config.prometheus)},
                { name: 'OBKA_LOG_LEVEL', value:JSON.stringify(spec.config.logLevel)}
              ],
              imagePullPolicy: 'Never'   //+++ this is a specific requirementof K3D
            },
          ],
        },
      },
      strategy: {
        type: 'RollingUpdate',
        rollingUpdate: {
          maxSurge: 1,
          maxUnavailable: 0
        }
      }
    };


    // Crete the Deploymnet object
    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: deploymentName,
        namespace: authorizatorNamespace
      },
      spec: deploymentSpec,
    };

    await appsApi.replaceNamespacedDeployment(deploymentName, authorizatorNamespace, deployment);
    log(1,'Deployment successfully modified');
  }
  catch (err) {
    log(0,'Error modifying ObkAuthorizator');
    log(0,err);
  }              
}


async function processModify (authorizatorObject:any) {
  var namespace=authorizatorObject.metadata.namespace;
  if (namespace===undefined) namespace='default';

  var ingress=authorizatorObject.spec.ingress;
  if (! (await checkIngress(ingress.name, namespace, ingress.class))) {
    log(0,"Ingress validation failed: "+ingress.name);
    return false;
  }
  await modifyObkAuthorizator(authorizatorObject.metadata.name, namespace, authorizatorObject.spec);
  return true;
}


async function testAccess(){
  try {
    log(0,"Testing cluster access");
    const nss = await coreApi.listNamespace();
  }
  catch (err) {
    log(0,"Error accessing cluster on Controller start:");
    log(0,err);
  }
}

async function listen() {
  if (enableConsole) {
    log(0,'Configuring Web Console endpoint');

    const app = express();
    const port=3882;
    app.listen(port, () => {
      log(0,`Oberkorn Controller Web Console listening at port ${port}`);
    });
  
    app.use(bodyParser.json());
    
    // serve SPA as a static endpoint
    app.use('/obk-console', express.static('./dist/console'))

    // serve cluster authorizators list
    app.use('/obk-console/authorizators', async (req,res) => {
      var auth = await crdApi.listClusterCustomObject('jfvilas.at.outlook.com', 'v1', 'obkauthorizators');
      var auths=[];
      for (auth of (auth.body as any).items) {
        auths.push ( { name: (auth as any).metadata.name, namespace: (auth as any).metadata.namespace } );
      }
      res.status(200).end(JSON.stringify(auths));
    });
  }
}

async function main() {
  try {
    // launch express to serve web console
    listen();

    log(0,"Oberkorn Controller is watching events...");
    const watch = new k8s.Watch(kc);  
    watch.watch('/apis/jfvilas.at.outlook.com/v1/obkauthorizators', {},
      async (type, obj) => {
        log(0,"Received event: "+type);
        log(0,`${obj.metadata.namespace}/${obj.metadata.name} (${obj.spec.ingress.class})`);
        log(1,obj);
        switch(type) {
          case "ADDED":
            await processAdd(obj);
            break;
          case "DELETED":
            await processDelete(obj);
            break;
          case "MODIFIED":
            await processModify(obj);
            break;

          default:
            log(0,"****** UNKNOWN EVENT ******: "+type)
            log(0,type);
            log(0,obj);
            break;
        }
      },
      (err) => {
        log(0,err);  
      }
    );
  }
  catch (err) {
    log(0,"MAINERR");
    log(0,err);
  }
};


function log(level:number, obj:any) {
  if (logLevel>=level) console.log(obj);
}


function redirLog() {
  console.log("Redirecting log");

  const origLog=console.log;

  console.log = (a) => {
    if (a && a.response!==undefined) {
      //console.log(typeof(a));
      a={
          statusCode: a.response.statusCode,
          statuesMessage:a.response.statusMessage,
          method: a.response.request.method,
          path: a.response.request.path,
          body: a.response.body
        };
    }
    origLog(a);
  }
  console.error = (a:object) => {
    origLog("*********ERR*********");
    origLog(a);
  }
  console.debug = (a:object) => {
    origLog("*********DEB*********");
    origLog(a);
  } 
}


/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
console.log('Oberkorn Controller is starting...');
console.log(`Oberkorn Controller version is ${VERSION}`);
if (process.env.OBKC_LOG_LEVEL!==undefined) logLevel= +process.env.OBKC_LOG_LEVEL;
if (process.env.OBKC_CONSOLE==='true') enableConsole = true;
console.log('Log level: '+logLevel);

// filter log messages
redirLog();

if (!testAccess()) {
  console.log("Oberkorn controller cannot access cluster");
}
else {
  // launch controller
  main();
}
