k3d cluster delete oberkorn
k3d cluster create oberkorn -p "80:80@loadbalancer" -p "443:443@loadbalancer" -p "8080:8080@loadbalancer" --k3s-arg "--disable=traefik@server:*"
timeout 5 > NUL
kubectl create namespace dev
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.9.4/deploy/static/provider/cloud/deploy.yaml
