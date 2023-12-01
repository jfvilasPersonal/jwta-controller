# Welcome

This repo contains all source artifacts needed to create the JWTA-Controller component of the JST Authorizator project.

## JWT Authorizator project
JWT Authorizator is a module built for having the flexibility to deploye  JWT validation in front of application projects deployed
inside a Kubernetes cluster whose access is performed via Nginx Ingress Controller.



## JWTA Controller
The JWTA Controller is the responsible of listening for JWT Atuhtorizar operations, that is, the controller listens for cluster events regarding the management of JWT Authorizators, thaty is, creaiton of new authorizators, deleltin of modifications.

### Authorizator creation
When a new JWT Authorizator is created, the controller recceives an "ADDED" event from the control plane fo the cluster anf perform following tasks:

  - Validates teh requests.
  - Creates a config map containing all the configuration that the authorizator needs for working.
  - Creates a desployment with n replicas of the image of JWTA-Authorizator.
  - Creates a service to route authorization requests to the authorizator.
  - If an nginx-ingress-controller has been specified in the YAML, this controllers updates the ingress controller to make him point it's authorization needs to the newly created authorizator.
  
