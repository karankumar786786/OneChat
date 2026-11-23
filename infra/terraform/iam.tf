# The engine's own identity: it can read, write and delete objects in this bucket, nothing else.
# (In production on AWS, prefer an IAM role for the server over long-lived keys.)

resource "aws_iam_user" "engine" {
  name = "${var.project}-engine-${var.environment}"
  path = "/apps/"
}

data "aws_iam_policy_document" "engine_s3" {
  statement {
    sid = "Objects"
    # GetObject also covers HeadObject; Put+Get cover the in-place copy used by forwarding.
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.files.arn}/*"]
  }

  statement {
    sid = "Bucket"
    # Lets HeadObject answer 404 (not 403) for missing uploads.
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.files.arn]
  }
}

resource "aws_iam_user_policy" "engine_s3" {
  name   = "s3-files"
  user   = aws_iam_user.engine.name
  policy = data.aws_iam_policy_document.engine_s3.json
}

resource "aws_iam_access_key" "engine" {
  user = aws_iam_user.engine.name
}
