/**
 * What a template name may be (#369): the rule release names have on the API —
 * an RFC 1123 hostname that is also a Kubernetes label value. The name is one
 * path segment in every template route, and it becomes the
 * `kubeport.io/template` label on every object a release creates.
 *
 * The backend binds createTemplateReq.Name with `hostname_rfc1123` and checks it
 * as a label value; openapi.yaml documents the two together as the TemplateName
 * `pattern` and `maxLength`. template-name.test.ts holds this copy to the
 * document, and the backend's spec test holds the document to the server.
 *
 * The pattern: starts and ends with a letter or digit, and a dot is always
 * followed by one. It reads the same in Go RE2 and JavaScript.
 */
export const TEMPLATE_NAME_PATTERN = "^[a-zA-Z0-9](-*\\.?[a-zA-Z0-9])*$";
export const TEMPLATE_NAME_MAX_LENGTH = 63;

const TEMPLATE_NAME_RE = new RegExp(TEMPLATE_NAME_PATTERN);

export type TemplateNameProblem = "empty" | "format";

export function templateNameProblem(name: string): TemplateNameProblem | null {
  if (name.trim() === "") return "empty";
  // Length first: it is cheap, and it bounds what the pattern has to read.
  if (name.length > TEMPLATE_NAME_MAX_LENGTH) return "format";
  return TEMPLATE_NAME_RE.test(name) ? null : "format";
}
