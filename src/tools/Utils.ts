
export const post = async (url:string,data:any) => {
    return fetch (url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)});
}

function getValue (item:any, key:string) {
    var i = key.indexOf('.');
    while (i>=0) {
        var pkey=key.substring(0,i);
        item=item[pkey];
        key=key.substring(i+1);
        i = key.indexOf('.');
    }
    return item[key];
}
     
export const reduce =  (results:any[], merge:any={}) => {
    var result:any={};

    for (var tkey of Object.keys(merge)) {
        var action= merge[tkey];
        var skey=Object.keys(action)[0];
        var oper=action[skey];
        switch(oper) {
            case 'copy':
                result[tkey]=getValue(results[0],skey);
                break;
            case 'sum':
                result[tkey]=results.map(item => getValue(item,skey)).reduce((prev, next) => prev + next);
                break;
            case 'or':
                result[tkey]=results.map(item => getValue(item,skey)).reduce((prev, next) => prev || next);
                break;
            case 'and':
                result[tkey]=results.map(item => getValue(item,skey)).reduce((prev, next) => prev && next);
                break;
            case 'avg':
                result[tkey]=results.map(item => getValue(item,skey)).reduce((prev, next) => prev + next) / results.length;
                break;
            case 'max':
                result[tkey]=results.reduce((max, item) => (getValue(item,skey) > max ? getValue(item,skey) : max), getValue(results[0],skey));
                break;
            case 'min':
                result[tkey]=results.reduce((max, item) => (getValue(item,skey) < max ? getValue(item,skey) : max), getValue(results[0],skey));
                break;
            case 'array':
                result[tkey]=[];
                results.map(item => result[tkey].push(getValue(item,skey)));
                break;
            case 'merge':
                result[tkey]=[];
                results.map( item => result[tkey]=result[tkey].concat(getValue(item,skey)));
                break;                    
        }
    }
    return result;
}

