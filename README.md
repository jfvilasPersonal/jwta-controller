# Welcome

Here we share some info on how to create an Oberkorn controller of the [Oberkorn Authorizator project](https://jfvilaspersonal.github.io/oberkorn).

## Oberkorn Authorizator project
Oberkorn Authorizator is a module created for having the flexibility to deploy token validation (JWT or whatever token type) in front of any application project deployed
inside a Kubernetes cluster where the access is managed via Ingress.

The Oberkorn authorizator project is made up of several components:
  - *Custom Resource Definitions*. The way a Oberkorn authorizator can be deployed is based on kubernetes CRD's. You can see examples in the Oberkorn Authorizator repositories explaning how to build and deploy an authorizator using such CRD's.
  - *Controller*. Creating CRD's is a good starting point, but for the CRD's to do something useful, you need to have a controller who can listen for CRD events (resource creation, resource modification and resource deletion). The Oberkorn controller is deployed to kubernetes as a Deployment.
  - *Authorizator*. The Authorizator is the component in charge of managing users requests and deciding, according to specs included in the CRD's, where to approve or deny access requests to web resources.

This repo contains everything you need to deploy an Oberkorn Controller.

## Oberkorn controller operation
The Oberkorn controller is the responsible of listening for Oberkorn authorizator operations, that is, the controller listens for cluster events regarding the management of Oberkorn authorizators: creation of new authorizators, deletion of modifications.

### Authorizator creation
When a new Oberkorn authorizator is created, the controller receives an "ADDED" event from the control plane of the kubernetes cluster and performs following tasks:

  - Validates the request.
  - Creates a config map containing all the configuration that the authorizator needs for working.
  - If an nginx-ingress-controller has been specified in the CRD, the controller will update the ingress controller to make him point it's authorization endpoint to the newly created authorizator (see Nginx Ingress Controller annnotations to understand this process).
  - Creates a deployment with at least 1 replica of the image OBK-Authorizator (this deployment will do the magic for you).
  - Creates a service to route authorization requests from the ingress controller to the authorizator.

### Authorizator modification
When a deployed authorizator needs to be changed, you can just 'kubectl apply' the changes in a CRD YAML and the controller will update the authorizator configuration accordingly. For this to work properly, the controller will perform this tasks:

  - Validate the request.
  - Apply changes to the authorizator's config map. 
  - Apply changes to the authorizator deployment.
  - If an ingress controller has been specified, then the Oberkorn controller will reconfigure the ingress through annotations.

### Authorizator deletion
When you just don't need the authorizator any more, you can just 'kubectl delete' the YAML of your auhtorizator and the controller will:

  - Validate the request.
  - Delete the config map, the deployment and the service.
  - Remove Ingress Controller annotations if there where any in place.

## Oberkorn controller Architecture
This is how the controller works:

![Control Plane](https://jfvilaspersonal.github.io/oberkorn/_media/architecture/controlplane.png)

The flow is as follows:
  1. You create a YAML containing the specs of an Oberkorn Authorizator. See the rest of the documentation on how to uild a YAML like this.
  2. You apply the YAML to create the authorizator: 'kubectl apply -f your-authorizator-code.yaml'.
  3. The controller, which is listening for 'ObkAuthorizator' events receives an 'ADDED' event, so the controller creates all the resources needed to deploy an authorizator (a pod, a service, and, optionally, it configures your ingress to point its authorization needs to the new 'ObkAuthorizator').
  4. You can make changes to your auhtorizator (like changing scale process, modifying the ruleset...), so when you apply a new YAML the controller receives a 'MODIFIED' event and it performs requested changes.
  5. When you no longer need an Authorizator, you can 'kubectl delete' it and the controller will receive a 'DELETED' event and it will deprovision all previously provisioned resources (and optional configuration).

## Oberkorn controller installation
Follow these simple steps to have your Oberkorn controller deployed:

  1. Create the CRD for the Oberkorn authorizator (this CRD is the one you need to be able to create authorizators).
        ```bash
        kubectl apply -f https://raw.githubusercontent.com/jfvilasPersonal/obk-controller/main/installation/crd.yaml
        ```

  2. Deploy the controller. the controller needs some permissions to be able to create resources:
       1. Needs access to the core API group, the networking API group and the Apps API group.
       2. Needs permissions to create, modify and delete resources in that groups.
       3. Needs permissions to access any namespace inside the kubernetes cluster.
       So, you need to apply following YAML:

      ```bash
       kubectl apply -f https://raw.githubusercontent.com/jfvilasPersonal/obk-controller/main/installation/controller-deployment.yaml
       ```
       
**That's it!**

## Oberkorn architecture
Oberkorn is build around two separate resources: **the controller** (in charge of the control plane) and **the authorizator** (repsonsible of the data plane). The architecture of the whole project is depicted below.

Oberkorn provides a web console that is protected using an Oberkorn Authorizator.

![Oberkorn architecture](https://jfvilaspersonal.github.io/oberkorn/_media/architecture/oberkorn-architecture.png)

