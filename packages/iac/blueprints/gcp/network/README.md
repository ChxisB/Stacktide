# network, GCP

A custom-mode VPC with one subnet, and private service access so Cloud SQL can have a private address. Names are derived from the stack: the network and its subnet are both `<environment>-<name>-network`.

- **Creates:** `google_compute_network`, `google_compute_subnetwork`, a reserved `/20` range and the service networking connection. Enables the `compute` and `servicenetworking` APIs (and leaves them on when destroyed).
- **Safe by default:** no firewall rule, no external address; the subnet has private Google access.
- **Needs from the runner's identity:** `roles/compute.networkAdmin` and `roles/serviceusage.serviceUsageAdmin` on the project.
- **Idle cost:** none. A network, a subnet and a reserved range are free; traffic through them is not.
- **Outputs:** `network_name`, `subnetwork_name`, `console_url`.
