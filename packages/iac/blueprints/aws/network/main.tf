locals {
  # The stack's name. A service or database in the same environment finds the VPC by this Name tag.
  id    = "${var.environment}-${var.name}-network"
  zones = slice(data.aws_availability_zones.available.names, 0, 2)
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = local.id }
}

# A VPC's default security group lets its members talk to each other and to anything. Declaring it with no
# rule takes every rule away, so nothing is allowed by default.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${local.id}-default" }
}

# Two private subnets for the tasks and the database, two public ones for the load balancer and the NAT
# gateway. A resource in a public subnet gets no public address of its own.
resource "aws_subnet" "private" {
  count = 2

  vpc_id            = aws_vpc.this.id
  availability_zone = local.zones[count.index]
  cidr_block        = cidrsubnet(var.cidr, 4, count.index)

  tags = { Name = "${local.id}-private-${count.index}", Tier = "private" }
}

resource "aws_subnet" "public" {
  count = 2

  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.zones[count.index]
  cidr_block              = cidrsubnet(var.cidr, 4, count.index + 8)
  map_public_ip_on_launch = false

  tags = { Name = "${local.id}-public-${count.index}", Tier = "public" }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = { Name = local.id }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${local.id}-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count = 2

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# One NAT gateway, in the first zone: the private subnets can reach the internet (to pull an image) and
# nothing can reach them. If that zone is down, outbound traffic from both private subnets stops with it.
resource "aws_eip" "nat" {
  domain = "vpc"

  tags = { Name = "${local.id}-nat" }
}

resource "aws_nat_gateway" "this" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id

  tags = { Name = local.id }

  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${local.id}-private" }
}

resource "aws_route" "private_nat" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this.id
}

resource "aws_route_table_association" "private" {
  count = 2

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}
