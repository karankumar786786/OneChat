output "bucket_name" {
  value = aws_s3_bucket.files.bucket
}

output "region" {
  value = var.region
}

output "engine_user" {
  value = aws_iam_user.engine.name
}

output "engine_access_key_id" {
  value     = aws_iam_access_key.engine.id
  sensitive = true
}

output "engine_secret_access_key" {
  value     = aws_iam_access_key.engine.secret
  sensitive = true
}
