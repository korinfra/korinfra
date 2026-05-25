resource "aws_instance" "web" {
  instance_type = "t3.micro"
  ami           = "ami-0abcdef1234567890"
}
