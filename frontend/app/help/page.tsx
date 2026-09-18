import { getTranslations } from "next-intl/server";
import { LandingCompare } from "@/components/LandingCompare";
import { loadShowcase } from "@/lib/showcase/load";

export default async function HelpPage() {
  const t = await getTranslations("operations");
  const showcase = loadShowcase();
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">{t("help")}</h1>
      <p>{t("roles")}</p>
      <p className="text-sm text-muted-foreground">{t("demo")}</p>
      <LandingCompare
        resourcesYaml={showcase.resourcesYaml}
        uiSpecYaml={showcase.uiSpecYaml}
      />
    </div>
  );
}
