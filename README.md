# Welcome

This repo contains all source artifacts needed to create the JWTA-Controller component of the JWT Authorizator project.

## JWT Authorizator project
JWT Authorizator is a module created for having the flexibility to deploy JWT validation in front of any application project deployed
inside a Kubernetes cluster where the access is managed via Nginx Ingress Controller.

The JWT Authorizator project is made up of several components:
  - *Custom Resource Definitions*. The way a JWT Authorizator can be deployed is based on kubernetes CRD's. You can see examples in the JWT Authorizator repositories explaninni how to build and deploy an authorizator using such crd's.
  - *Controller*. Creating crd's is a good starting point, but for the crd's to do something useful, you need tu have a controller who can listen for crd events (resource creation, resource modification and reource deletion). The JWT Authorizator controller is deployed to kubernetes as a Deployment.
  - *Authorizator*. The Authorizator es the component in chargo of managin users requests and decidingm according to specs included in the crd's, where to approve or deny access requests.

This repo contains everything you neet to deploy a JWT Authorizator controller.

## JWTA Controller operation
The JWTA Controller is the responsible of listening for JWT Atuhtorizar operations, that is, the controller listens for cluster events regarding the management of JWT Authorizators, thaty is, creaiton of new authorizators, delletion of modifications.

### Authorizator creation
When a new JWT Authorizator is created, the controller receives an "ADDED" event from the control plane of the cluster anf performs following tasks:

  - Validates the requests.
  - Creates a config map containing all the configuration that the authorizator needs for working.
  - If an nginx-ingress-controller has been specified in the crd YAML, the controller will update the ingress controller to make him point it's authorization endpoint to the newly created authorizator (see Nginx Ingress Controller annnotations to understand this process).
  - Creates a deployment with at least 1 replica of the image of JWTA-Authorizator (this deployment will do the magic for you).
  - Creates a service to route authorization requests form the ingress controller to the authorizator.

### Authorizator modification
When a deployed authorizator need to be changed, you can just 'kubectl apply' the changes in a crd YAML and the controller will update the authorizator configuration accordingly. For this to work properly, the controller will perform this tasks:

  - Validates the requests.
  - Applyes changes to the authorizator's config map. 
  - Applies changes to the authorizator deployment.
  - If an inggress controller has been specified, then JWTA-Controller will reconfigure the ingress through annotations.

### Authorizator deletion
When you just don't need the authorizator any more, you can just 'kubectl delete' the YAML of your auhtorizator and teh controller will:

  - Validate the request.
  - Delete the config map, the deployment and the service.
  - Remove Ingress controller annotations if there where any in place.

## JWTA Controller Architecture

  >> include a diagram and some explanation

## JWTA Controller Installation
Follow these simple steps to have your JWTA Controller deployed:

  1. Create the CRD fr JWT Authorizator (this crd is the one you need to be able to create authorizators)
        kubectl apply -f https://raw.githubusercontent.com/jfvilasPersonal/jwta-controller/main/crd/crd.yaml
  2. Deploy the controller. the controller needs some permissions to be able to create resources:
       1. Needs access to the core API group, the networking API group and the Apps API group
       2. Needs permissions to create, modify and delete resources in that groups
       3. Needs permissions to access any namespace inside the kubernetes cluster.
       So, you need to apply foollowing YAML:
       kubectl apply -f https://raw.githubusercontent.com/jfvilasPersonal/jwta-controller/main/crd/controller.yml

That's it.
