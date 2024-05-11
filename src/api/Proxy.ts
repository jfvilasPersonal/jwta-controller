import express from 'express';
import * as k8s from '@kubernetes/client-node';

export class ProxyApi {
    public route = express.Router();
    coreApi:k8s.CoreV1Api;


    constructor (clusterName:string, kapi:k8s.CoreV1Api) {
        this.coreApi=kapi;
        var serviceName='', pathPrefix='', hostPort='', localPath='', authorizatorNamespace='', path='';

        this.route.route('/*')
        .all ( async (req,res,next) =>  {

            path=req.originalUrl;
            console.log('url:'+path);
            var i = path.indexOf('/proxy/');
            path=path.substring(i+7);
            console.log('local:'+path);
            i=path.indexOf('/');
            authorizatorNamespace=path.substring(0,i);
            path=path.substring(i+1);
            i=path.indexOf('/');
            var authorizatorName=path.substring(0,i);
            path=path.substring(i);

            serviceName=`obk-authorizator-${authorizatorName}-svc`;
            pathPrefix=`/obk-authorizator/${authorizatorNamespace}/${authorizatorName}`
            hostPort=`http://${serviceName}.${authorizatorNamespace}.svc.${clusterName}:3882`;
            localPath=pathPrefix+path;

            console.log('authns:'+authorizatorNamespace);
            console.log('authnm:'+authorizatorName);
            console.log('authsvc:'+serviceName);
            console.log('path:'+path);
            console.log('address:'+hostPort+localPath);
            next();
        })
        .get ( async (req,res,next) =>  {
            var destination='svc'; // 'all'
            var merge={};
            if (path==='/api/overview/status') {
                destination='all';
                merge={ totalRequests:{totalRequests:'sum'}, totalMicros:{totalMicros:'sum'}};
            }
            else if (path==='/api/overview/config' || path==='/api/overview/validators' || path==='/api/overview/rulesets') {
                destination='svc';
                merge={ };
            }

            try {
                var resp=await this.multiGetData(serviceName, authorizatorNamespace, localPath, destination, merge);
                console.log('response');
                console.log(resp);
                res.status(200).json(resp);
            }
            catch (err) {
                console.log(err);
                res.status(500).json(err);
            }
        })
        .put ( async (req,res,next) =>  {
            try {
                var a = await this.postData(hostPort+localPath,req.body);
                console.log('a:'+a);
                res.status(200).json(a);
            }
            catch (err) {
                console.log('catch');
                console.log(err);
                res.status(500).json({ ok:false, err:err });
            }
            //next();
        })
        .post ( async (req,res,next) =>  {
            try {
                var destination='svc';
                var merge={};

                if (path==='/api/trace/subject') {
                    destination='all';
                    merge={ ok:{ok:'and'}, okDetail:{ok:'array'}, id:{ id:'min'}};
                }
                else if (path==='/api/trace/events') {
                    destination='all';
                    merge={ ok:{ok:'and'}, okDetail:{ok:'array'}, events:{ events:'merge'}};
                }
                else if (path==='/api/trace/stop') {
                    destination='all';
                    merge={ ok:{ok:'and'}, okDetail:{ok:'array'}};
                }
                else if (path==='/api/invalidate') {
                    destination='svc';
                    merge={};
                }
                else  if (path==='/api/invalidate/sub' || path==='/api/invalidate/iss' || path==='/api/invalidate/aud' || path==='/api/invalidate/claim') {
                    destination='all';
                    merge={};
                }

                var a = await this.multiPostData(serviceName, authorizatorNamespace, localPath, req.body, destination, merge);
                console.log('a:'+a);
                res.status(200).json(a);
            }
            catch (err) {
                console.log(err);
                console.log('catch');
                res.status(500).json({ ok:false, err:err });
            }
            //next();
        });       
    }


    async getPodIPs(serviceName: string, namespace: string): Promise<string[]> {
        try {
            // Get service details
            const service:any = await this.coreApi.readNamespacedService(serviceName, namespace);
            console.log('service');
            console.log(service);
            // Get pods with matching labels
            const selector = service.body.spec.selector;
            const labelSelector = Object.entries(selector)
                .map(([key, value]) => `${key}=${value}`)
                .join(',');
            console.log('selector');
            console.log(labelSelector);
            const podList = await this.coreApi.listNamespacedPod(namespace, undefined, undefined, undefined, undefined, labelSelector);
            console.log('filtrado:'+podList.body.items.length);
      
            console.log('podlist');
            console.log(podList.body.items);
      
            // Retrieve IP addresses of pods
            const podIPs = podList.body.items.map(pod => pod.status?.podIP || '');
            console.log(podIPs);
      
            return podIPs;
        }
        catch (err) {
            console.error('Error:', err);
            return [];
        }
    }
      
      
    reduce (results:any[], merge:any={}) {
        var result:any={};

        for (var tkey of Object.keys(merge)) {
            var action= merge[tkey];
            var skey=Object.keys(action)[0];
            var oper=action[skey];
            console.log(`action: ${action}`);
            console.log(`key: ${skey}`);
            console.log(`oper: ${oper}`);
            switch(oper) {
                case 'sum':
                    result[tkey]=results.map(item => item[skey]).reduce((prev, next) => prev + next);
                    break;
                case 'or':
                    result[tkey]=results.map(item => item[skey]).reduce((prev, next) => prev || next);
                    break;
                case 'and':
                    result[tkey]=results.map(item => item[skey]).reduce((prev, next) => prev && next);
                    break;
                case 'avg':
                    result[tkey]=results.map(item => item[skey]).reduce((prev, next) => prev + next) / results.length;
                    break;
                case 'max':
                    result[tkey]=results.reduce((max, obj) => (obj[skey] > max ? obj[skey] : max), results[0][skey]);
                    break;
                case 'min':
                    result[tkey]=results.reduce((max, obj) => (obj[skey] < max ? obj[skey] : max), results[0][skey]);
                    break;
                case 'array':
                    result[tkey]=[];
                    results.map(item=> result[tkey].push(item[skey]));
                    break;
                case 'merge':
                    result[tkey]=[];
                    results.map( item => result[tkey]=result[tkey].concat(item[skey]));
                    break;
                        
            }
        }
        return result;
    }


    async getData(url = "", data = {}) : Promise<{}> {
        // Default options are marked with *
        console.log('toget:'+JSON.stringify(data));
        const response = await fetch(url);
        var ct=response.headers.get('content-type');
        if (ct?.startsWith('text/')) {
          var r=await response.text();
          console.log(r);
          return {};
        }
        else {
          return await response.json(); // parses JSON response into native JavaScript objects
        }
    }


    async multiGetData(service='', namespace='', localPath = "", destination='svc', merge:any={}) : Promise<{}> {
        var podIps = await this.getPodIPs(service, namespace);
        var results=[]
        for (var ip of podIps) {
          var url=`http://${ip}:3882${localPath}`;
          var resp = await this.getData(url);
          console.log('response from '+ip);
          console.log(resp);
          results.push(resp);
        }

        if (Object.keys(merge).length===0) return results[0];
        return this.reduce(results,merge);
    }


    async postData(url = "", data = {}) : Promise<{}> {
        // Default options are marked with *
        console.log('tosend:'+JSON.stringify(data));
        const response = await fetch(url, {
          method: "POST", // *GET, POST, PUT, DELETE, etc.
          mode: "cors", // no-cors, *cors, same-origin
          cache: "no-cache", // *default, no-cache, reload, force-cache, only-if-cached
          credentials: "same-origin", // include, *same-origin, omit
          headers: {
            "Content-Type": "application/json"
          },
          redirect: "follow", // manual, *follow, error
          referrerPolicy: "no-referrer", // no-referrer, *no-referrer-when-downgrade, origin, origin-when-cross-origin, same-origin, strict-origin, strict-origin-when-cross-origin, unsafe-url
          body: JSON.stringify(data), // body data type must match "Content-Type" header
        });
        var ct=response.headers.get('content-type');
        if (ct?.startsWith('text/')) {
          var r=await response.text();
          console.log(r);
          return {};
        }
        else {
          return await response.json(); // parses JSON response into native JavaScript objects
        }
    }

          
    async multiPostData(service='', namespace='', localPath = "", data = {}, destination='svc', merge:any={}) {
        var podIps = await this.getPodIPs(service, namespace);
        var results=[]
        for (var ip of podIps) {
          var url=`http://${ip}:3882${localPath}`;
          var resp = await this.postData(url, data);
          console.log('response from '+ip);
          console.log(resp);
          results.push(resp);
        }

        if (Object.keys(merge).length===0) return results[0];
        return this.reduce(results,merge);
      }  


}