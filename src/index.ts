import * as k8s from '@kubernetes/client-node';
import { NetworkingV1Api, CoreV1Api, AppsV1Api,  } from '@kubernetes/client-node';
//import { CustomObjectsApi } from '@kubernetes/client-node';

// Configura la conexion con el cluster Kubernetes
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
var logLevel=0;

// Crea el cliente de Kubernetes
const networkingApi = kc.makeApiClient(NetworkingV1Api);
const coreApi = kc.makeApiClient(CoreV1Api);
const appsApi = kc.makeApiClient(AppsV1Api);
//const customApi = kc.makeApiClient(CustomObjectsApi);

async function checkIngress (n:any,ns:any,c:any) {
  if (c!="nginx") {
    log(0,"Unsupported ingress class: "+c);
    return false;    
  }

  // validar que exista el ns y el ingress
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


async function createJwtAuthorizator (jwtaName:string,jwtaNamespace:string,spec:any) {
  //create configmap  
  log(1,'Creando Configmap');
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
  try {
    await coreApi.createNamespacedConfigMap(jwtaNamespace,configMap);
    log(1,'Configmap creado con exito');
  }
  catch (err) {
    log(0,'Error creando Configmap');
    log(0,err);
  }


  //create deployment
  log(1,'Creando Deployment');
  var deploymentName = 'jwta-authorizator-'+jwtaName+'-dep';

  try {
    var appName="jwta-authorizator-"+jwtaName+"-listener";

    // Definir la configuracion del deployment spec
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
              imagePullPolicy: 'Never'   //+++ esto ES PARA K3D
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

    // Crear el Deployment en el cluster
    await appsApi.createNamespacedDeployment(jwtaNamespace, deployment);
    log(1,'Deployment creado con exito');



    // Crear el service
    log(1,'Creando service');
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
    log(1,'Service creado con exito');



    // anotar el ingress
    // +++ hay qeu ver que hacemos con los jwta shared
    log(1,'Anotando ingress '+spec.ingress.name);
    const response2 = await networkingApi.readNamespacedIngress(spec.ingress.name, jwtaNamespace);
    var ingressObject:any = response2.body;

    ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-url'] = `http://jwta-authorizator-${jwtaName}-svc.dev.svc.cluster.local:3000/validate/${jwtaName}`;
    ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-method'] = 'POST';

    await networkingApi.replaceNamespacedIngress(spec.ingress.name, jwtaNamespace, ingressObject);
    log(1,'Actualizado ingress');
  }
  catch (err) {
    log(0,'Error al crearJwtAuthorizator');
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


async function deleteJwtAuthorizator (jwtaName:string,namespace:string) {
  try {
    // recuperar config
    var configmapName="jwta-authorizator-"+jwtaName+"-configmap";
    var configMapResp = await coreApi.readNamespacedConfigMap(configmapName,namespace);
    var ingressName = (configMapResp.body.data as any).ingressName

    //delete  configmap
    var response = await coreApi.deleteNamespacedConfigMap(configmapName,namespace);

    //delete deployment
    var depName = 'jwta-authorizator-'+jwtaName+'-dep';
    response = await appsApi.deleteNamespacedDeployment(depName,namespace);
    log(1,'Deployment eliminado con exito');

    //delete service
    var servName = 'jwta-authorizator-'+jwtaName+'-svc';
    const respServ = await coreApi.deleteNamespacedService(servName, namespace);
    log(1,'Service eliminado con exito');

    //modificando ingress
    log(1,'Anotando ingress ');
    const ingressResponse = await networkingApi.readNamespacedIngress(ingressName, namespace);
    var ingressObject:any = ingressResponse.body;

    if (ingressObject.metadata.annotations) {
      if (ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-url']) delete ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-url'];
      if (ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-method']) delete ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-method'];
    }

    await networkingApi.replaceNamespacedIngress(ingressName, namespace, ingressObject);
    log(1,'actualizado ingress');
  }
  catch (err) {
    log(0,'Error eliminando JwtAuthorizator');
    log(0,err);
  }
}


function processDelete(jwtaObject:any) {
  var ns=jwtaObject.metadata.namespace;
  if (ns===undefined) ns='default';

  deleteJwtAuthorizator(jwtaObject.metadata.name, ns);
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
  log(1,'Configmap modificado con exito');



  //create deployment
  log(1,'Modificando Deployment');
  var deploymentName = 'jwta-authorizator-'+jwtaName+'-dep';

  try {
    var appName="jwta-authorizator-"+jwtaName+"-listener";

    // Definir la configuracion del deployment spec
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
                //{ name: 'JWTA_VALIDATORS', value:JSON.stringify(spec.validators)},
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
    log(1,'Deployment modificado con exito');




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
    // ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-method'] = 'POST';

    // await networkingApi.replaceNamespacedIngress(spec.ingress.name, jwtaNamespace, ingressObject);
    // console.log('Actualizado ingress');
    // revisar si el ingress ha cambiado:

  }
  catch (err) {
    log(0,'Error al crearJwtAuthorizator');
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
  modifyJwtAuthorizator(jwtaObject.metadata.name, namespace, jwtaObject.spec);
  return true;
}


async function testAccess(){
  try {
    log(0,"Testing cluster access");
    const nss = await coreApi.listNamespace();
    //console.log(JSON.stringify(nss.body));
    // nss.body.items.forEach( element => {
    //   //console.log((element as any).metadata.name);
    // });
  }
  catch (err) {
    log(0,"Error accessing cluster on Controller start:");
    log(0,err);
  }
}


async function main() {
  try {
    log(0,"JWT Authorizator controller is watching events...");
    const watch = new k8s.Watch(kc);  
    //watch.watch('/apis/jfvilas.at.outlook.com/v1/namespaces/default/jwtauthorizators', {},
    watch.watch('/apis/jfvilas.at.outlook.com/v1/jwtauthorizators', {},
      (type, obj) => {
        log(1,"Received event: "+type);
        log(1,obj.metadata.namespace+":"+obj.metadata.name);
        log(1,obj);
        switch(type) {
          case "ADDED":
            processAdd(obj);
            break;
          case "DELETED":
            processDelete(obj);
            break;
          case "MODIFIED":
            processModify(obj);
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
  console.error = (a:object, b:object) => {
    console.log(a);
    console.log(b);
    origLog("*********ERR*********");
    origLog(a);
  }
  console.debug = (a:object, b:object) => {
    console.log(a);
    console.log(b);
    origLog("*********DEB*********");
    origLog(a);
  } 
}


/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
console.log('JWT Authorizator controller is starting...');
if (process.env.JWTA_LOG_LEVEL!==undefined) logLevel= +process.env.JWTA_LOG_LEVEL;
console.log('Log level: '+logLevel);

// filtrar log messages
redirLog();

if (!testAccess()) {
  console.log("JWT Authorizator cannot access cluster");
}
else {
  // launch controller
  main();
}
