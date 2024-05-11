
export const post = async (url:string,data:any) => {
    return fetch (url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)});
} 
     
export const reduce =  (results:any[], merge:any={}) => {
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

