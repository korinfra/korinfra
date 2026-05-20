/** Terraform file extensions recognized by the parser and security scanner. */
export const TERRAFORM_EXTENSIONS = ['.tf', '.tf.json'] as const;

/** Status strings for recommendation lifecycle. */
export const STATUS_APPLIED = 'applied';
export const STATUS_DISMISSED = 'dismissed';
