kubectl delete -f crd\crd.yaml
kubectl delete -f controller.yaml
@REM kubectl delete configmap obk-authorizator-ja-jfvilas-configmap -n dev
@REM kubectl delete deployment obk-authorizator-ja-jfvilas-deply -n dev
@REM kubectl delete service  obk-authorizator-ja-jfvilas-svc -n dev

cd ..\obk-console
call npm run build
cd ..\obk-controller
mkdir dist\console
xcopy /s /y ..\obk-console\build\*.* dist\console

call update-version
call npm run build
docker image rm obk-controller:latest
set DOCKER_BUILDKIT=1
set COMPOSE_DOCKER_CLI_BUILD=0
docker build . -t obk-controller:latest
k3d image import obk-controller:latest -t -c oberkorn
timeout 5
kubectl apply -f crd\crd.yaml
timeout 5
kubectl apply -f controller.yaml
