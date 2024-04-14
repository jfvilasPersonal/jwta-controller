import * as k8s from '@kubernetes/client-node';
import { NetworkingV1Api, CoreV1Api, AppsV1Api, CustomObjectsApi } from '@kubernetes/client-node';

// Configures connection to the Kubernetes cluster
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
var logLevel=0;

// Create the kubernetes clients
const networkingApi = kc.makeApiClient(NetworkingV1Api);
const coreApi = kc.makeApiClient(CoreV1Api);
const appsApi = kc.makeApiClient(AppsV1Api);
const crdApi = kc.makeApiClient(CustomObjectsApi);

async function checkIngress (n:any,ns:any,c:any) {
  log(0, 'Ingress class: '+c);
  // if (c!="nginx") {
  //   log(0,"Unsupported ingress class: "+c);
  //   return false;    
  // }

  // Check that ingress do exist
  try {
    var ing = await networkingApi.readNamespacedIngress(n, ns);
    log(1,ing);
  }
  catch (err: any) {
    if (err.statusCode===404)
      log(0,"Error, inexistent ingress: "+n);
    else {
      log(0,"Error checking ingress");
      log(0,err);
    }
    return false;
  }
  return true;  
}


async function createTraefikMiddleware(authorizatorName:string,authorizatorNamespace:string,spec:any) {
  // +++ crear un recurso crd
  /*
  apiVersion: traefik.io/v1alpha1
  kind: Middleware
  metadata:
    name: testauth
    namespace: dev
  spec:
    forwardAuth:
      address: http://obk-authorizator-ja-jfvilas-svc.dev.svc.cluster.local:3000/validate/ja-jfvilas
  */
  var address=`http://obk-authorizator-${authorizatorName}-svc.dev.svc.cluster.local:3000/validate/${authorizatorName}`;
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

async function annotateIngress(authorizatorName:string,authorizatorNamespace:string,spec:any) {
    // +++ hay que ver que hacemos con los obk shared

    /* NGINX Ingress
    nginx.org/location-snippets: |
      auth_request /auth;
    nginx.org/server-snippets: |
      location = /auth {
        proxy_pass http://obk-authorizator-ja-jfvilas-svc.dev.svc.cluster.local:3000/validate/ja-jfvilas;
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
        ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-url'] = `http://obk-authorizator-${authorizatorName}-svc.dev.svc.cluster.local:3000/validate/${authorizatorName}`;
        ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-method'] = 'GET';
        break;
      case 'nginx-ingress':
        var locationSnippet = 'auth_request /obk-auth;';
        var serverSnippet = `location = /obk-auth { proxy_pass http://obk-authorizator-${authorizatorName}-svc.dev.svc.cluster.local:3000/validate/${authorizatorName}; proxy_pass_request_body off; proxy_set_header Content-Length ""; proxy_set_header X-Original-URI $request_uri; }`;
        ingressObject.metadata.annotations['nginx.org/location-snippets'] = locationSnippet;
        ingressObject.metadata.annotations['nginx.org/server-snippets'] = serverSnippet;
        break;
      case 'haproxy':
        log (0,'HAProxy ingress still not supported... we are working hard!');
        break;
      case 'traefik':
        await createTraefikMiddleware(authorizatorName, authorizatorNamespace, spec);
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
  //create configmap  
  log(1,'Creating Configmap');
  var configmapName="obk-authorizator-"+authorizatorName+"-configmap";

  const configMapData = {
    namespace:authorizatorNamespace,
    name:authorizatorName,
    ingressName:spec.ingress.name,
    ruleset: JSON.stringify(spec.ruleset)
  };
  
  var configMap:k8s.V1ConfigMap = new k8s.V1ConfigMap();
  configMap = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: configmapName,
      namespace:authorizatorNamespace
    },
    data: configMapData,
  };
  await coreApi.createNamespacedConfigMap(authorizatorNamespace,configMap);

  // try {
  //   await coreApi.createNamespacedConfigMap(authorizatorNamespace,configMap);
  //   log(1,'Configmap creado con exito');
  // }
  // catch (err) {
  //   log(0,'Error creando Configmap');
  //   log(0,err);
  // }


  //create deployment
  log(1,'Creating Deployment');
  var deploymentName = 'obk-authorizator-'+authorizatorName+'-dep';

  try {
    var appName='obk-authorizator-'+authorizatorName+'-listener';

    // Create the spec fo the deployment
    const deploymentSpec = {
      replicas: spec.config.replicas,
      selector: { matchLabels: { app: appName } },
      template: {
        metadata: { labels: { app: appName } },
        spec: {
          containers: [
            {
              name: appName,
              image: 'obk-authorizator',
              ports: [ {containerPort:3000, protocolo:'TCP'} ],
              env: [ 
                { name: 'OBKA_NAME', value: authorizatorName},
                { name: 'OBKA_NAMESPACE', value: authorizatorNamespace},
                { name: 'OBKA_RULESET', value:JSON.stringify(spec.ruleset)},
                { name: 'OBKA_VALIDATORS', value:JSON.stringify(spec.validators)},
                { name: 'OBKA_PROMETHEUS', value:JSON.stringify(spec.config.prometheus)},
                { name: 'OBKA_LOG_LEVEL', value:JSON.stringify(spec.config['log-level'])}
              ],
              imagePullPolicy: 'Never'   //+++ this is a specific requirementof K3D
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



    // Cretae a Service
    log(1,'Creting service service');
    var serviceBody:k8s.V1Service = new k8s.V1Service();
    serviceBody= {
      apiVersion: "v1",
      metadata: {
        name: 'obk-authorizator-'+authorizatorName+'-svc',
        namespace: authorizatorNamespace
      },
      spec: {
        ports: [ { protocol: 'TCP', port: 3000, targetPort: 3000 } ],
        selector: { app: appName },
        type: 'ClusterIP'
      }
    }

    await coreApi.createNamespacedService(authorizatorNamespace, serviceBody);
    log(1,'Service created succesfully');

    await annotateIngress(authorizatorName, authorizatorNamespace, spec);
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
    // recuperar config
    var configmapName="obk-authorizator-"+authorizatorName+"-configmap";
    var configMapResp = await coreApi.readNamespacedConfigMap(configmapName,authorizatorNamespace);
    var ingressName = (configMapResp.body.data as any).ingressName

    //delete  configmap
    var response = await coreApi.deleteNamespacedConfigMap(configmapName,authorizatorNamespace);

    //delete deployment
    var depName = 'obk-authorizator-'+authorizatorName+'-dep';
    response = await appsApi.deleteNamespacedDeployment(depName,authorizatorNamespace);
    log(1,'Deployment successfully removed');

    //delete service
    var servName = 'obk-authorizator-'+authorizatorName+'-svc';
    const respServ = await coreApi.deleteNamespacedService(servName, authorizatorNamespace);
    log(1,'Service successfully removed');

    //modificando ingress
    log(1,'De-annotating ingress ');
//    try {
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
          //await deleteTraefikMiddleware(authorizatorName, authorizatorNamespace, spec);
          var name = `obk-traefik-middleware-${authorizatorName}`;
          await crdApi.deleteNamespacedCustomObject('traefik.io', 'v1alpha1', authorizatorNamespace, 'middlewares', name);        
          break;
      }
      await networkingApi.replaceNamespacedIngress(ingressName, authorizatorNamespace, ingressObject);
      log(1,'Ingress updated');
    // }
    // catch (err) {
    //   log(0,'Error de-annotating ingress');
    //   log(0,err);
    //   }
  }
  catch (err) {
    log(0,'Error removing ObkAuthorizator');
    log(0,err);
  }
}


async function processDelete(authorizatorObject:any) {
  var ns=authorizatorObject.metadata.namespace;
  if (ns===undefined) ns='default';

  await deleteObkAuthorizator(authorizatorObject.metadata.name, ns, authorizatorObject.spec);
}


async function modifyObkAuthorizator (authorizatorName:string,authorizatorNamespace:string,spec:any) {
  //create configmap  
  log(1,'Modificando Configmap');
  var configMapName="obk-authorizator-"+authorizatorName+"-configmap";

  const configMapData = {
    namespace:authorizatorNamespace,
    name:authorizatorName,
    ingressName:spec.ingress.name,
    ruleset: JSON.stringify(spec.ruleset)
  };
  var configMap:k8s.V1ConfigMap = new k8s.V1ConfigMap();
  configMap = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: configMapName,
      namespace:authorizatorNamespace
    },
    data: configMapData,
  };
  await coreApi.replaceNamespacedConfigMap(configMapName, authorizatorNamespace,configMap);
  log(1,'Configmap successfully modified');



  // modify the Deployment
  log(1,'Modifying Deployment');
  var deploymentName = 'obk-authorizator-'+authorizatorName+'-dep';

  try {
    var appName="obk-authorizator-"+authorizatorName+"-listener";

    // Create the spec
    const deploymentSpec = {
      replicas: spec.config.replicas,
      selector: { matchLabels: { app: appName } },
      template: {
        metadata: { labels: { app: appName } },
        spec: {
          containers: [
            {
              name: appName,
              image: 'obk-authorizator',
              ports: [ {containerPort:3000, protocolo:'TCP'} ],
              env: [ 
                { name: 'OBKA_NAME', value: authorizatorName},
                { name: 'OBKA_NAMESPACE', value: authorizatorNamespace},
                { name: 'OBKA_RULESET', value:JSON.stringify(spec.ruleset)},
                { name: 'OBKA_VALIDATORS', value:JSON.stringify(spec.validators)},
                { name: 'OBKA_PROMETHEUS', value:JSON.stringify(spec.config.prometheus)},
                { name: 'OBKA_LOG_LEVEL', value:JSON.stringify(spec.config['log-level'])}
                //+++ ¿prometheus?
              ],
              imagePullPolicy: 'Never'   //+++ esto ES PARA K3D
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


    // Crear el objeto Deployment
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


async function main() {
  try {
    log(0,"Oberkorn Controller is watching events...");
    const watch = new k8s.Watch(kc);  
    //watch.watch('/apis/jfvilas.at.outlook.com/v1/namespaces/default/obkauthorizators', {},
    watch.watch('/apis/jfvilas.at.outlook.com/v1/obkauthorizators', {},
      async (type, obj) => {
        log(0,"Received event: "+type);
        log(0,obj.metadata.namespace+"/"+obj.metadata.name);
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
            log(0,"****** EVENT UNKNOWN: "+type)
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
      console.log(typeof(a));
      a={
          statusCode: a.response.statusCode,
          statuesMessage:a.response.statusMessage,
          method: a.response.request.method,
          path: a.response.request.path,
          body: a.response.body
        };
    }
    // if (typeof(a)==='string') {
    //   if ((a as string).length>200) {
    //     origLog( ">>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>"+(a as string).substring(0,200));
    //   }
    // }
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
console.log('Oberkorn controller is starting...');
if (process.env.OBKA_LOG_LEVEL!==undefined) logLevel= +process.env.OBKA_LOG_LEVEL;
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

