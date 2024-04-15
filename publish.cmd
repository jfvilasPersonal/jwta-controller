call npm run build
set /p major=<major
set /p minor=<minor
set /p level=<level
set currversion=%major%.%minor%.%level%
set /a level=%level%+1
echo %level% > level
set nextversion=%major%.%minor%.%level%
echo %currversion% to %nextversion%
docker image rm obk-controller:latest
docker build . -t obk-controller -t jfvilasoutlook/obk-controller:%nextversion% -t jfvilasoutlook/obk-controller:latest
docker push jfvilasoutlook/obk-controller:%nextversion%
docker push jfvilasoutlook/obk-controller:latest
