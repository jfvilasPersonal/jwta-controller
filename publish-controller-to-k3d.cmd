kubectl config use-context k3d-oberkorn
kubectl delete -f crd\crd.yaml
kubectl delete -f controller-deployment.yaml
kubectl delete -f controller-webconsole.yaml

del dist\*.js /s /q
del dist\console\*.* /s /q
cd ..\obk-console
call npm run build
if errorlevel 1 (
    cd ..\obk-controller
    echo ***************************************
    echo *********** ERROR EN BUILD ************
    echo ***************************************
    exit /b %errorlevel%
)
cd ..\obk-controller
mkdir dist\console
xcopy /s /y ..\obk-console\build\*.* dist\console

call update-version
call npm run build
if errorlevel 1 (
    cd ..\obk-controller
    echo ***************************************
    echo *********** ERROR EN BUILD ************
    echo ***************************************
    exit /b %errorlevel%
)

docker image rm obk-controller:latest
set DOCKER_BUILDKIT=1
set COMPOSE_DOCKER_CLI_BUILD=0
docker build . -t obk-controller:latest
k3d image import obk-controller:latest -t -c oberkorn
timeout 3
kubectl apply -f crd\crd.yaml
timeout 3
kubectl apply -f controller-deployment.yaml
timeout 3
kubectl apply -f controller-webconsole.yaml
