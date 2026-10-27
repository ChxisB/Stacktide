# network, AWS

A VPC with two private and two public subnets across two zones, an internet gateway, one NAT gateway and an empty default security group. The VPC carries the Name tag `<environment>-<name>-network`; its subnets carry `Tier = private` or `Tier = public`. A service or database in the same environment finds them by those tags.

- **Creates:** `aws_vpc`, four `aws_subnet`, `aws_internet_gateway`, `aws_nat_gateway` with its `aws_eip`, two route tables and `aws_default_security_group`.
- **Safe by default:** the default security group has no rule; no subnet hands out public addresses; the only route to the internet from the private subnets is the NAT gateway, which lets traffic out and not in.
- **Needs from the runner's role:** the EC2 network actions (`ec2:*Vpc*`, `*Subnet*`, `*RouteTable*`, `*Route`, `*InternetGateway*`, `*NatGateway*`, `*Address*`, `*SecurityGroup*`, `CreateTags`) and `ec2:DescribeAvailabilityZones`.
- **Idle cost:** the NAT gateway bills by the hour (about 32 USD a month in us-east-1) plus per GB it processes, whether or not anything runs. Nothing else here costs anything while idle.
- **One NAT gateway:** if its zone is down, outbound traffic from both private subnets stops.
- **Outputs:** `vpc_id`, `private_subnet_ids`, `public_subnet_ids`, `console_url`.
