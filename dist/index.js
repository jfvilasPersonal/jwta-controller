"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const k8s = __importStar(require("@kubernetes/client-node"));
const client_node_1 = require("@kubernetes/client-node");
const version_1 = require("./version");
// Configures connection to the Kubernetes cluster
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
var logLevel = 0;
// Create the kubernetes clients
const networkingApi = kc.makeApiClient(client_node_1.NetworkingV1Api);
const coreApi = kc.makeApiClient(client_node_1.CoreV1Api);
const appsApi = kc.makeApiClient(client_node_1.AppsV1Api);
const crdApi = kc.makeApiClient(client_node_1.CustomObjectsApi);
async function checkIngress(n, ns, c) {
    // Check that ingress do exist
    try {
        var ing = await networkingApi.readNamespacedIngress(n, ns);
        log(1, ing);
    }
    catch (err) {
        if (err.statusCode === 404)
            log(0, "Error, inexistent ingress: " + n);
        else {
            log(0, "Error checking ingress");
            log(0, err);
        }
        return false;
    }
    return true;
}
//+++ Traefik middleware is under development
async function createTraefikMiddleware(authorizatorName, authorizatorNamespace, clusterName, spec) {
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
    var address = `http://obk-authorizator-${authorizatorName}-svc.${authorizatorNamespace}.svc.${clusterName}:3000/validate/${authorizatorName}`;
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
    };
    log(2, 'Creating traefik middleware: ');
    log(2, resource);
    await crdApi.createNamespacedCustomObject('traefik.io', 'v1alpha1', authorizatorNamespace, 'middlewares', resource);
}
async function annotateIngress(authorizatorName, authorizatorNamespace, clusterName, spec) {
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
    log(1, 'Annotating ingress ' + spec.ingress.name + ' of provider ' + spec.ingress.provider);
    const response2 = await networkingApi.readNamespacedIngress(spec.ingress.name, authorizatorNamespace);
    var ingressObject = response2.body;
    switch (spec.ingress.provider) {
        case 'ingress-nginx':
            ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-url'] = `http://obk-authorizator-${authorizatorName}-svc.${authorizatorNamespace}.svc.${clusterName}:3000/validate/${authorizatorName}`;
            ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-method'] = 'GET';
            ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-response-headers'] = 'WWW-Authenticate';
            break;
        case 'nginx-ingress':
            //var headersSnippet = 'sssss';
            var locationSnippet = 'auth_request /obk-auth;';
            var serverSnippet = `location = /obk-auth { proxy_pass http://obk-authorizator-${authorizatorName}-svc.${authorizatorNamespace}.svc.${clusterName}:3000/validate/${authorizatorName}; proxy_pass_request_body off; proxy_set_header Content-Length ""; proxy_set_header X-Original-URI $request_uri; }`;
            ingressObject.metadata.annotations['nginx.org/location-snippets'] = locationSnippet;
            ingressObject.metadata.annotations['nginx.org/server-snippets'] = serverSnippet;
            break;
        case 'haproxy':
            log(0, 'HAProxy ingress still not supported... we are working hard!');
            break;
        case 'traefik':
            await createTraefikMiddleware(authorizatorName, authorizatorNamespace, clusterName, spec);
            ingressObject.metadata.annotations['traefik.ingress.kubernetes.io/router.middlewares'] = `${authorizatorNamespace}-obk-traefik-middleware-${authorizatorName}@kubernetescrd`;
            break;
        default:
            log(0, 'Invalid ingress provider to annotate');
            break;
    }
    await networkingApi.replaceNamespacedIngress(spec.ingress.name, authorizatorNamespace, ingressObject);
    log(1, 'Ingress annotated');
}
async function createObkAuthorizator(authorizatorName, authorizatorNamespace, spec) {
    //create deployment
    log(1, 'Creating Deployment');
    var deploymentName = 'obk-authorizator-' + authorizatorName + '-deply';
    try {
        var appName = 'obk-authorizator-' + authorizatorName + '-listener';
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
                    containers: [
                        {
                            name: appName,
                            image: 'obk-authorizator',
                            ports: [{ containerPort: 3000, protocol: 'TCP' }],
                            env: [
                                { name: 'OBKA_NAME', value: authorizatorName },
                                { name: 'OBKA_NAMESPACE', value: authorizatorNamespace },
                                { name: 'OBKA_RULESET', value: JSON.stringify(spec.ruleset) },
                                { name: 'OBKA_VALIDATORS', value: JSON.stringify(spec.validators) },
                                { name: 'OBKA_PROMETHEUS', value: JSON.stringify(spec.config.prometheus) },
                                { name: 'OBKA_LOG_LEVEL', value: JSON.stringify(spec.config.logLevel) }
                            ],
                            imagePullPolicy: 'Never' //+++ this is a specific requirementof K3D
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
        log(1, 'Deployment successfully created');
        // Cretae a Service
        log(1, 'Creting service service');
        var serviceName = 'obk-authorizator-' + authorizatorName + '-svc';
        var serviceBody = new k8s.V1Service();
        serviceBody = {
            apiVersion: "v1",
            metadata: {
                name: serviceName,
                namespace: authorizatorNamespace
            },
            spec: {
                ports: [{ protocol: 'TCP', port: 3000, targetPort: 3000 }],
                selector: { app: appName },
                type: 'ClusterIP'
            }
        };
        await coreApi.createNamespacedService(authorizatorNamespace, serviceBody);
        log(1, 'Service created succesfully');
        await annotateIngress(authorizatorName, authorizatorNamespace, 'cluster.local', spec);
    }
    catch (err) {
        log(0, 'Error  creating the ObkAuthorizator');
        log(0, err);
    }
}
async function processAdd(authorizatorObject) {
    var namespace = authorizatorObject.metadata.namespace;
    if (namespace === undefined)
        namespace = 'default';
    var ingress = authorizatorObject.spec.ingress;
    if (!(await checkIngress(ingress.name, namespace, ingress.class))) {
        log(0, "Ingress validation failed");
        return false;
    }
    createObkAuthorizator(authorizatorObject.metadata.name, namespace, authorizatorObject.spec);
    return true;
}
async function deleteObkAuthorizator(authorizatorName, authorizatorNamespace, spec) {
    var _a, _b, _c;
    try {
        var deploymentName = 'obk-authorizator-' + authorizatorName + '-deply';
        var depResp = await appsApi.readNamespacedDeployment(deploymentName, authorizatorNamespace);
        var deployment = depResp.body;
        var ingressName = ((_c = (_b = (_a = deployment.spec) === null || _a === void 0 ? void 0 : _a.template) === null || _b === void 0 ? void 0 : _b.metadata) === null || _c === void 0 ? void 0 : _c.annotations)['oberkorn.jfvilas.at.outlook.com/ingress'];
        //delete deployment
        var response = await appsApi.deleteNamespacedDeployment(deploymentName, authorizatorNamespace);
        log(1, `Deployment ${deploymentName} successfully removed`);
        //delete service
        var servName = 'obk-authorizator-' + authorizatorName + '-svc';
        const respServ = await coreApi.deleteNamespacedService(servName, authorizatorNamespace);
        log(1, `Service ${servName} successfully removed`);
        // de-annotate ingress
        log(1, 'De-annotating ingress ' + ingressName);
        const ingressResponse = await networkingApi.readNamespacedIngress(ingressName, authorizatorNamespace);
        var ingressObject = ingressResponse.body;
        switch (spec.ingress.provider) {
            case 'ingress-nginx':
                if (ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-url'])
                    delete ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-url'];
                if (ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-method'])
                    delete ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-method'];
                break;
            case 'nginx-ingress':
                if (ingressObject.metadata.annotations['nginx.org/location-snippets'])
                    delete ingressObject.metadata.annotations['nginx.org/location-snippets'];
                if (ingressObject.metadata.annotations['nginx.org/server-snippets'])
                    delete ingressObject.metadata.annotations['nginx.org/server-snippets'];
                break;
            case 'traefik':
                var name = `obk-traefik-middleware-${authorizatorName}`;
                await crdApi.deleteNamespacedCustomObject('traefik.io', 'v1alpha1', authorizatorNamespace, 'middlewares', name);
                break;
        }
        await networkingApi.replaceNamespacedIngress(ingressName, authorizatorNamespace, ingressObject);
        log(1, 'Ingress updated');
    }
    catch (err) {
        log(0, 'Error removing ObkAuthorizator');
        log(0, err);
    }
}
async function processDelete(authorizatorObject) {
    var ns = authorizatorObject.metadata.namespace;
    if (ns === undefined)
        ns = 'default';
    await deleteObkAuthorizator(authorizatorObject.metadata.name, ns, authorizatorObject.spec);
}
async function modifyObkAuthorizator(authorizatorName, authorizatorNamespace, spec) {
    // modify the Deployment
    log(1, 'Modifying Deployment');
    var deploymentName = 'obk-authorizator-' + authorizatorName + '-deply';
    try {
        var appName = "obk-authorizator-" + authorizatorName + "-listener";
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
                            ports: [{ containerPort: 3000, protocol: 'TCP' }],
                            env: [
                                { name: 'OBKA_NAME', value: authorizatorName },
                                { name: 'OBKA_NAMESPACE', value: authorizatorNamespace },
                                { name: 'OBKA_RULESET', value: JSON.stringify(spec.ruleset) },
                                { name: 'OBKA_VALIDATORS', value: JSON.stringify(spec.validators) },
                                { name: 'OBKA_PROMETHEUS', value: JSON.stringify(spec.config.prometheus) },
                                { name: 'OBKA_LOG_LEVEL', value: JSON.stringify(spec.config.logLevel) }
                            ],
                            imagePullPolicy: 'Never' //+++ this is a specific requirementof K3D
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
        log(1, 'Deployment successfully modified');
    }
    catch (err) {
        log(0, 'Error modifying ObkAuthorizator');
        log(0, err);
    }
}
async function processModify(authorizatorObject) {
    var namespace = authorizatorObject.metadata.namespace;
    if (namespace === undefined)
        namespace = 'default';
    var ingress = authorizatorObject.spec.ingress;
    if (!(await checkIngress(ingress.name, namespace, ingress.class))) {
        log(0, "Ingress validation failed: " + ingress.name);
        return false;
    }
    await modifyObkAuthorizator(authorizatorObject.metadata.name, namespace, authorizatorObject.spec);
    return true;
}
async function testAccess() {
    try {
        log(0, "Testing cluster access");
        const nss = await coreApi.listNamespace();
    }
    catch (err) {
        log(0, "Error accessing cluster on Controller start:");
        log(0, err);
    }
}
async function main() {
    try {
        log(0, "Oberkorn Controller is watching events...");
        const watch = new k8s.Watch(kc);
        watch.watch('/apis/jfvilas.at.outlook.com/v1/obkauthorizators', {}, async (type, obj) => {
            log(0, "Received event: " + type);
            log(0, `${obj.metadata.namespace}/${obj.metadata.name} (${obj.spec.ingress.class})`);
            log(1, obj);
            switch (type) {
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
                    log(0, "****** UNKNOWN EVENT ******: " + type);
                    log(0, type);
                    log(0, obj);
                    break;
            }
        }, (err) => {
            log(0, err);
        });
    }
    catch (err) {
        log(0, "MAINERR");
        log(0, err);
    }
}
;
function log(level, obj) {
    if (logLevel >= level)
        console.log(obj);
}
function redirLog() {
    console.log("Redirecting log");
    const origLog = console.log;
    console.log = (a) => {
        if (a && a.response !== undefined) {
            //console.log(typeof(a));
            a = {
                statusCode: a.response.statusCode,
                statuesMessage: a.response.statusMessage,
                method: a.response.request.method,
                path: a.response.request.path,
                body: a.response.body
            };
        }
        origLog(a);
    };
    console.error = (a) => {
        origLog("*********ERR*********");
        origLog(a);
    };
    console.debug = (a) => {
        origLog("*********DEB*********");
        origLog(a);
    };
}
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
console.log('Oberkorn Controller is starting...');
console.log(`Oberkorn Controller version is ${version_1.VERSION}`);
if (process.env.OBKC_LOG_LEVEL !== undefined)
    logLevel = +process.env.OBKC_LOG_LEVEL;
console.log('Log level: ' + logLevel);
// filter log messages
redirLog();
if (!testAccess()) {
    console.log("Oberkorn controller cannot access cluster");
}
else {
    // launch controller
    main();
}
