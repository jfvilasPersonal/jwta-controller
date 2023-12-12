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
      log(0,"Inexistent ingress: "+n);
    else {
      log(0,"Error checking ingress");
      log(0,err);
    }
    return false;
  }
  return true;  
}


async function createTraefikMiddleware(jwtaName:string,jwtaNamespace:string,spec:any) {
  // +++ crear un recurso crd
  /*
  apiVersion: traefik.io/v1alpha1
  kind: Middleware
  metadata:
    name: testauth
    namespace: dev
  spec:
    forwardAuth:
      address: http://jwta-authorizator-ja-jfvilas-svc.dev.svc.cluster.local:3000/validate/ja-jfvilas
  */
  var address=`http://jwta-authorizator-${jwtaName}-svc.dev.svc.cluster.local:3000/validate/${jwtaName}`;
  var resource = {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'Middleware',
    metadata: {
      name: `jwta-traefik-middleware-${jwtaName}`,
      namespace: jwtaNamespace
    },
    spec: {
      forwardAuth: {
        address: address
      }
    }
  }
  log(2, 'Creating traefik middleware: ');
  log(2, resource);
  await crdApi.createNamespacedCustomObject('traefik.io', 'v1alpha1', jwtaNamespace, 'middlewares', resource); 
}

async function annotateIngress(jwtaName:string,jwtaNamespace:string,spec:any) {
    // +++ hay que ver que hacemos con los jwta shared

    /* NGINX Ingress
    nginx.org/location-snippets: |
      auth_request /auth;
    nginx.org/server-snippets: |
      location = /auth {
        proxy_pass http://jwta-authorizator-ja-jfvilas-svc.dev.svc.cluster.local:3000/validate/ja-jfvilas;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header X-Original-URI $request_uri;
      }
    */
    log(1,'Annotating ingress '+spec.ingress.name+' of provider '+spec.ingress.provider);
    const response2 = await networkingApi.readNamespacedIngress(spec.ingress.name, jwtaNamespace);
    var ingressObject:any = response2.body;

    switch(spec.ingress.provider) {
      case 'ingress-nginx':
        ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-url'] = `http://jwta-authorizator-${jwtaName}-svc.dev.svc.cluster.local:3000/validate/${jwtaName}`;
        ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-method'] = 'GET';
        break;
      case 'nginx-ingress':
        var locationSnippet = 'auth_request /jwt-auth;';
        var serverSnippet = `location = /jwt-auth { proxy_pass http://jwta-authorizator-${jwtaName}-svc.dev.svc.cluster.local:3000/validate/${jwtaName}; proxy_pass_request_body off; proxy_set_header Content-Length ""; proxy_set_header X-Original-URI $request_uri; }`;
        ingressObject.metadata.annotations['nginx.org/location-snippets'] = locationSnippet;
        ingressObject.metadata.annotations['nginx.org/server-snippets'] = serverSnippet;
        break;
      case 'haproxy':
        log (0,'HAProxy ingress still not supported... we are working hard!');
        break;
      case 'traefik':
        await createTraefikMiddleware(jwtaName, jwtaNamespace, spec);
        ingressObject.metadata.annotations['traefik.ingress.kubernetes.io/router.middlewares'] = `${jwtaNamespace}-jwta-traefik-middleware-${jwtaName}@kubernetescrd`;
        break;
      default:
        log (0,'Invalid ingress provider to annotate');
        break;
    }

    await networkingApi.replaceNamespacedIngress(spec.ingress.name, jwtaNamespace, ingressObject);
    log(1,'Ingress annotated');
}


async function createJwtAuthorizator (jwtaName:string,jwtaNamespace:string,spec:any) {
  //create configmap  
  log(1,'Creating Configmap');
  var configmapName="jwta-authorizator-"+jwtaName+"-configmap";

  const configMapData = {
    namespace:jwtaNamespace,
    name:jwtaName,
    ingressName:spec.ingress.name,
    ruleset: JSON.stringify(spec.ruleset)
  };
  
  var configMap:k8s.V1ConfigMap = new k8s.V1ConfigMap();
  configMap = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: configmapName,
      namespace:jwtaNamespace
    },
    data: configMapData,
  };
  await coreApi.createNamespacedConfigMap(jwtaNamespace,configMap);

  // try {
  //   await coreApi.createNamespacedConfigMap(jwtaNamespace,configMap);
  //   log(1,'Configmap creado con exito');
  // }
  // catch (err) {
  //   log(0,'Error creando Configmap');
  //   log(0,err);
  // }


  //create deployment
  log(1,'Creating Deployment');
  var deploymentName = 'jwta-authorizator-'+jwtaName+'-dep';

  try {
    var appName="jwta-authorizator-"+jwtaName+"-listener";

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
              image: 'jwta-authorizator',
              ports: [ {containerPort:3000, protocolo:'TCP'} ],
              env: [ 
                { name: 'JWTA_NAME', value: jwtaName},
                { name: 'JWTA_NAMESPACE', value: jwtaNamespace},
                { name: 'JWTA_RULESET', value:JSON.stringify(spec.ruleset)},
                { name: 'JWTA_VALIDATORS', value:JSON.stringify(spec.validators)},
                { name: 'JWTA_PROMETHEUS', value:JSON.stringify(spec.config.prometheus)}
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
        namespace: jwtaNamespace
      },
      spec: deploymentSpec,
    };

    // Create the Deployment in the cluster
    await appsApi.createNamespacedDeployment(jwtaNamespace, deployment);
    log(1,'Deployment successfully created');



    // Cretae a Service
    log(1,'Creting service service');
    var serviceBody:k8s.V1Service = new k8s.V1Service();
    serviceBody= {
      apiVersion: "v1",
      metadata: {
        name: 'jwta-authorizator-'+jwtaName+'-svc',
        namespace: jwtaNamespace
      },
      spec: {
        ports: [ { protocol: 'TCP', port: 3000, targetPort: 3000 } ],
        selector: { app: appName },
        type: 'ClusterIP'
      }
    }

    await coreApi.createNamespacedService(jwtaNamespace, serviceBody);
    log(1,'Service created succesfully');

    await annotateIngress(jwtaName, jwtaNamespace, spec);
  }
  catch (err) {
    log(0,'Error  creating the JwtAuthorizator');
    log(0,err);
  }              
}


async function processAdd(jwtaObject: any) {
  var namespace=jwtaObject.metadata.namespace;
  if (namespace===undefined) namespace='default';
  var ingress=jwtaObject.spec.ingress;
  if (! (await checkIngress(ingress.name, namespace, ingress.class))) {
    log(0,"Ingress validation failed");
    return false;
  }
  createJwtAuthorizator(jwtaObject.metadata.name, namespace, jwtaObject.spec);
  return true;
}


async function deleteJwtAuthorizator (jwtaName:string,jwtaNamespace:string, spec:any) {
  try {
    // recuperar config
    var configmapName="jwta-authorizator-"+jwtaName+"-configmap";
    var configMapResp = await coreApi.readNamespacedConfigMap(configmapName,jwtaNamespace);
    var ingressName = (configMapResp.body.data as any).ingressName

    //delete  configmap
    var response = await coreApi.deleteNamespacedConfigMap(configmapName,jwtaNamespace);

    //delete deployment
    var depName = 'jwta-authorizator-'+jwtaName+'-dep';
    response = await appsApi.deleteNamespacedDeployment(depName,jwtaNamespace);
    log(1,'Deployment successfully removed');

    //delete service
    var servName = 'jwta-authorizator-'+jwtaName+'-svc';
    const respServ = await coreApi.deleteNamespacedService(servName, jwtaNamespace);
    log(1,'Service successfully removed');

    //modificando ingress
    log(1,'De-annotating ingress ');
//    try {
      const ingressResponse = await networkingApi.readNamespacedIngress(ingressName, jwtaNamespace);
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
          //await deleteTraefikMiddleware(jwtaName, jwtaNamespace, spec);
          var name = `jwta-traefik-middleware-${jwtaName}`;
          await crdApi.deleteNamespacedCustomObject('traefik.io', 'v1alpha1', jwtaNamespace, 'middlewares', name);        
          break;
      }
      await networkingApi.replaceNamespacedIngress(ingressName, jwtaNamespace, ingressObject);
      log(1,'Ingress updated');
    // }
    // catch (err) {
    //   log(0,'Error de-annotating ingress');
    //   log(0,err);
    //   }
  }
  catch (err) {
    log(0,'Error removing JwtAuthorizator');
    log(0,err);
  }
}


async function processDelete(jwtaObject:any) {
  var ns=jwtaObject.metadata.namespace;
  if (ns===undefined) ns='default';

  await deleteJwtAuthorizator(jwtaObject.metadata.name, ns, jwtaObject.spec);
}


async function modifyJwtAuthorizator (jwtaName:string,jwtaNamespace:string,spec:any) {
  //create configmap  
  log(1,'Modificando Configmap');
  var configMapName="jwta-authorizator-"+jwtaName+"-configmap";

  const configMapData = {
    namespace:jwtaNamespace,
    name:jwtaName,
    ingressName:spec.ingress.name,
    ruleset: JSON.stringify(spec.ruleset)
  };
  var configMap:k8s.V1ConfigMap = new k8s.V1ConfigMap();
  configMap = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: configMapName,
      namespace:jwtaNamespace
    },
    data: configMapData,
  };
  await coreApi.replaceNamespacedConfigMap(configMapName, jwtaNamespace,configMap);
  log(1,'Configmap successfully modified');



  // modify the Deployment
  log(1,'Modifying Deployment');
  var deploymentName = 'jwta-authorizator-'+jwtaName+'-dep';

  try {
    var appName="jwta-authorizator-"+jwtaName+"-listener";

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
              image: 'jwta-authorizator',
              ports: [ {containerPort:3000, protocolo:'TCP'} ],
              env: [ 
                { name: 'JWTA_NAME', value: jwtaName},
                { name: 'JWTA_NAMESPACE', value: jwtaNamespace},
                { name: 'JWTA_RULESET', value:JSON.stringify(spec.ruleset)},
                { name: 'JWTA_VALIDATORS', value:JSON.stringify(spec.validators)},
                { name: 'JWTA_LOG_LEVEL', value:"9"}
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
        namespace: jwtaNamespace
      },
      spec: deploymentSpec,
    };


    await appsApi.replaceNamespacedDeployment(deploymentName, jwtaNamespace, deployment);
    log(1,'Deployment successfully modified');




    //+++ no deberia haber cambios aqui
    // // Crear el service
    // console.log('Modificando service');
    // var serviceBody:k8s.V1Service = new k8s.V1Service();
    // serviceBody= {
    //   apiVersion: "v1",
    //   metadata: {
    //     name: 'jwta-authorizator-'+jwtaName+'-svc',
    //     namespace: jwtaNamespace
    //   },
    //   spec: {
    //     ports: [ { protocol: 'TCP', port: 3000, targetPort: 3000 } ],
    //     selector: { app: appName },
    //     type: 'ClusterIP'
    //   }
    // }

    // await coreApi.createNamespacedService(jwtaNamespace, serviceBody);
    // console.log('Service creado con exito');



    // anotar el ingress
    // hay que ver si el ingress viejo es igual la nuevo o no, y actuar ne consecuencia
    //+++ de momento no se permite
    // console.log('Anotando ingress ', spec.ingress.name);
    // const response2 = await networkingApi.readNamespacedIngress(spec.ingress.name, jwtaNamespace);
    // var ingressObject:any = response2.body;

    // ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-url'] = `http://jwta-authorizator-${jwtaName}-svc.dev.svc.cluster.local:3000/validate/${jwtaName}`;
    // ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-method'] = 'GET';

    // await networkingApi.replaceNamespacedIngress(spec.ingress.name, jwtaNamespace, ingressObject);
    // console.log('Actualizado ingress');
    // revisar si el ingress ha cambiado:

  }
  catch (err) {
    log(0,'Error modifying JwtAuthorizator');
    log(0,err);
  }              
}


async function processModify (jwtaObject:any) {
  var namespace=jwtaObject.metadata.namespace;
  if (namespace===undefined) namespace='default';

  var ingress=jwtaObject.spec.ingress;
  if (! (await checkIngress(ingress.name, namespace, ingress.class))) {
    log(0,"Ingress validation failed: "+ingress.name);
    return false;
  }
  await modifyJwtAuthorizator(jwtaObject.metadata.name, namespace, jwtaObject.spec);
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
    log(0,"JWTA Controller is watching events...");
    const watch = new k8s.Watch(kc);  
    //watch.watch('/apis/jfvilas.at.outlook.com/v1/namespaces/default/jwtauthorizators', {},
    watch.watch('/apis/jfvilas.at.outlook.com/v1/jwtauthorizators', {},
      async (type, obj) => {
        log(1,"Received event: "+type);
        log(1,obj.metadata.namespace+"/"+obj.metadata.name);
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
console.log('JWTA controller is starting...');
if (process.env.JWTA_LOG_LEVEL!==undefined) logLevel= +process.env.JWTA_LOG_LEVEL;
console.log('Log level: '+logLevel);

// filter log messages
redirLog();

if (!testAccess()) {
  console.log("JWTA controller cannot access cluster");
}
else {
  // launch controller
  main();
}

