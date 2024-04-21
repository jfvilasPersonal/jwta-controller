call npm run build
set /p major=<major
set /p minor=<minor
set /p level=<level
set currentversion=%major%.%minor%.%level%
docker image rm obk-controller:latest
docker build . -t obk-controller -t jfvilasoutlook/obk-controller:%currentversion% -t jfvilasoutlook/obk-controller:latest
docker push jfvilasoutlook/obk-controller:%currentversion%
docker push jfvilasoutlook/obk-controller:latest
