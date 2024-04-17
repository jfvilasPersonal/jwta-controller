call npm run build
kubectl delete -f crd\crd.yaml
kubectl delete -f controller.yaml
kubectl delete configmap obk-authorizator-ja-jfvilas-configmap -n dev
kubectl delete deployment obk-authorizator-ja-jfvilas-deply -n dev
kubectl delete service  obk-authorizator-ja-jfvilas-svc -n dev
docker image rm obk-controller:latest
set DOCKER_BUILDKIT=1
set COMPOSE_DOCKER_CLI_BUILD=0
docker build . -t obk-controller:latest
k3d image import obk-controller:latest -t -c oberkorn
kubectl apply -f crd\crd.yaml
kubectl apply -f controller.yaml
