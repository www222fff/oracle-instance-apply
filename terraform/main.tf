provider "oci" {}

variable "tenancy_ocid" {}

variable "compartment_ocid" {}

variable "image_ocid" {
	description = "启动镜像 OCID（Compute → Images 里选和 A1 兼容的 aarch64 镜像）"
}

# 如果 VCN 里已经有同网段的子网（比如之前 Apply 失败留下的），Apply 会报 CIDR overlaps。
# 这时取消下面的注释，填入现有子网的 OCID，并让下面子网的 display_name / dns_label 和现有子网保持一致，
# 否则 Terraform 会删掉重建子网。Terraform 1.5 的 import id 只能写字面量。
# import {
# 	to = oci_core_subnet.generated_oci_core_subnet
# 	id = "ocid1.subnet.oc1.<region>.<subnet-id>"
# }

data "oci_identity_availability_domains" "ads" {
	compartment_id = var.tenancy_ocid
}

locals {
	ad_names = sort(data.oci_identity_availability_domains.ads.availability_domains[*].name)
	# 和定时任务的间隔保持一致，每轮 Apply 换下一个可用域。
	ad_rotate_minutes = 5
	ad_slot = floor((parseint(formatdate("hh", timestamp()), 10) * 60 + parseint(formatdate("mm", timestamp()), 10)) / local.ad_rotate_minutes)
	availability_domain = local.ad_names[local.ad_slot % length(local.ad_names)]
}

output "availability_domain" {
	value = oci_core_instance.generated_oci_core_instance.availability_domain
}

resource "oci_core_instance" "generated_oci_core_instance" {
	agent_config {
		is_management_disabled = "false"
		is_monitoring_disabled = "false"
		plugins_config {
			desired_state = "DISABLED"
			name = "WebLogic Management Service"
		}
		plugins_config {
			desired_state = "DISABLED"
			name = "Vulnerability Scanning"
		}
		plugins_config {
			desired_state = "DISABLED"
			name = "Oracle Java Management Service"
		}
		plugins_config {
			desired_state = "DISABLED"
			name = "OS Management Hub Agent"
		}
		plugins_config {
			desired_state = "DISABLED"
			name = "Management Agent"
		}
		plugins_config {
			desired_state = "DISABLED"
			name = "Fleet Application Management Service"
		}
		plugins_config {
			desired_state = "ENABLED"
			name = "Custom Logs Monitoring"
		}
		plugins_config {
			desired_state = "DISABLED"
			name = "Compute RDMA GPU Monitoring"
		}
		plugins_config {
			desired_state = "ENABLED"
			name = "Compute Instance Run Command"
		}
		plugins_config {
			desired_state = "ENABLED"
			name = "Compute Instance Monitoring"
		}
		plugins_config {
			desired_state = "DISABLED"
			name = "Compute HPC RDMA Auto-Configuration"
		}
		plugins_config {
			desired_state = "DISABLED"
			name = "Compute HPC RDMA Authentication"
		}
		plugins_config {
			desired_state = "ENABLED"
			name = "Cloud Guard Workload Protection"
		}
		plugins_config {
			desired_state = "DISABLED"
			name = "Block Volume Management"
		}
		plugins_config {
			desired_state = "DISABLED"
			name = "Bastion"
		}
	}
	availability_config {
		recovery_action = "RESTORE_INSTANCE"
	}
	availability_domain = local.availability_domain
	lifecycle {
		ignore_changes = [availability_domain]
	}
	compartment_id = var.compartment_ocid
	create_vnic_details {
		assign_ipv6ip = "false"
		assign_private_dns_record = "true"
		assign_public_ip = "true"
		subnet_id = "${oci_core_subnet.generated_oci_core_subnet.id}"
	}
	display_name = "free-a1-instance"
	instance_options {
		are_legacy_imds_endpoints_disabled = "true"
	}
	is_pv_encryption_in_transit_enabled = "true"
	shape = "VM.Standard.A1.Flex"
	shape_config {
		memory_in_gbs = "6"
		ocpus = "1"
	}
	source_details {
		source_id = var.image_ocid
		source_type = "image"
	}
}

resource "oci_core_vcn" "generated_oci_core_vcn" {
	cidr_block = "10.0.0.0/16"
	compartment_id = var.compartment_ocid
	display_name = "free-vcn"
	dns_label = "freevcn"
}

resource "oci_core_subnet" "generated_oci_core_subnet" {
	cidr_block = "10.0.0.0/24"
	compartment_id = var.compartment_ocid
	display_name = "free-subnet"
	dns_label = "freesubnet"
	route_table_id = "${oci_core_vcn.generated_oci_core_vcn.default_route_table_id}"
	vcn_id = "${oci_core_vcn.generated_oci_core_vcn.id}"
}

resource "oci_core_internet_gateway" "generated_oci_core_internet_gateway" {
	compartment_id = var.compartment_ocid
	display_name = "free-vcn-igw"
	enabled = "true"
	vcn_id = "${oci_core_vcn.generated_oci_core_vcn.id}"
}

resource "oci_core_default_route_table" "generated_oci_core_default_route_table" {
	route_rules {
		destination = "0.0.0.0/0"
		destination_type = "CIDR_BLOCK"
		network_entity_id = "${oci_core_internet_gateway.generated_oci_core_internet_gateway.id}"
	}
	manage_default_resource_id = "${oci_core_vcn.generated_oci_core_vcn.default_route_table_id}"
}
