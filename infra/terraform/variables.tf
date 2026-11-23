variable "project" {
  description = "Short name used in resource names."
  type        = string
  default     = "chat"
}

variable "environment" {
  description = "dev, staging or prod. Each gets its own bucket and IAM user."
  type        = string
  default     = "dev"
}

variable "region" {
  description = "AWS region for the bucket."
  type        = string
  default     = "ap-south-1"
}

variable "chat_file_ttl_days" {
  description = "Days before files shared in chats are deleted. Must match FILE_TTL_DAYS in engine/.env."
  type        = number
  default     = 30
}

variable "force_destroy" {
  description = "Allow `terraform destroy` to delete the bucket even when it still has files."
  type        = bool
  default     = false
}
