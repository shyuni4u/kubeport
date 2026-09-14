/**
 * What a template name may be (#369): an RFC 1123 hostname, the rule release
 * names have on the API. The backend binds createTemplateReq.Name with
 * `hostname_rfc1123`, and openapi.yaml documents that regex as the TemplateName
 * pattern. template-name.test.ts holds this copy to the document, and the
 * backend's spec test holds the document to the binding.
 *
 * The name is one path segment in every template route, so a name with "/"
 * used to be created and then answer 404 everywhere.
 */
export const TEMPLATE_NAME_PATTERN =
  "^([a-zA-Z0-9]{1}[a-zA-Z0-9-]{0,62}){1}(\\.[a-zA-Z0-9]{1}[a-zA-Z0-9-]{0,62})*?$";

const TEMPLATE_NAME_RE = new RegExp(TEMPLATE_NAME_PATTERN);

export type TemplateNameProblem = "empty" | "format";

export function templateNameProblem(name: string): TemplateNameProblem | null {
  if (name.trim() === "") return "empty";
  return TEMPLATE_NAME_RE.test(name) ? null : "format";
}
