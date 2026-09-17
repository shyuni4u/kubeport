"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { ActionForm, type FormAction } from "@/components/ActionForm";
import { SubmitButton } from "@/components/SubmitButton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { fieldDescriptionClass } from "@/components/ui/field-styles";

export function TeamCreateForm({ action, disabled }: { action: FormAction; disabled?: boolean }) {
  const t = useTranslations("admin.teams");
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const submit: FormAction = async (previous, data) => {
    const result = await action(previous, data);
    if (!result?.error) { setName(""); setDisplayName(""); }
    return result;
  };
  return (
    <ActionForm action={submit} className="rounded-[12px] border bg-card p-5 space-y-4">
      <h2 className="font-semibold">{t("createButton")}</h2>
      <fieldset disabled={disabled} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="grid content-start gap-2">
          <Label htmlFor="team-name">{t("slugLabel")}</Label>
          <Input id="team-name" name="name" value={name} onChange={e => setName(e.target.value)} placeholder={t("slugPlaceholder")} required aria-describedby="team-slug-help" />
          <p id="team-slug-help" className={fieldDescriptionClass}>{t("slugHelp")}</p>
        </div>
        <div className="grid content-start gap-2">
          <Label htmlFor="team-display-name">{t("displayNameLabel")}</Label>
          <Input id="team-display-name" name="display_name" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder={t("displayNamePlaceholder")} />
        </div>
        <div className="sm:col-span-2 flex justify-end"><SubmitButton disabled={disabled}>{t("createButton")}</SubmitButton></div>
      </fieldset>
    </ActionForm>
  );
}

export function TeamMemberForm({ action, disabled }: { action: FormAction; disabled?: boolean }) {
  const t = useTranslations("admin.teams");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("editor");
  const submit: FormAction = async (previous, data) => {
    const result = await action(previous, data);
    if (!result?.error) { setEmail(""); setRole("editor"); }
    return result;
  };
  return (
    <ActionForm action={submit} className="rounded-[12px] border bg-card p-5 space-y-4">
      <h2 className="font-semibold">{t("addMemberHeading")}</h2>
      <fieldset disabled={disabled} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="grid content-start gap-2">
          <Label htmlFor="member-email">{t("emailLabel")}</Label>
          <Input id="member-email" name="email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder={t("emailPlaceholder")} required aria-describedby="member-login-help" />
          <p id="member-login-help" className={fieldDescriptionClass}>{t("loginHint")}</p>
        </div>
        <div className="grid content-start gap-2">
          <Label htmlFor="member-role">{t("roleLabel")}</Label>
          <NativeSelect id="member-role" name="role" value={role} onChange={e => setRole(e.target.value)} aria-describedby="member-role-help">
            <option value="editor">{t("roleEditor")}</option>
            <option value="viewer">{t("roleViewer")}</option>
          </NativeSelect>
          <p id="member-role-help" className={fieldDescriptionClass}>{t("roleHelp")}</p>
        </div>
        <div className="sm:col-span-2 flex justify-end"><SubmitButton disabled={disabled}>{t("addMemberButton")}</SubmitButton></div>
      </fieldset>
    </ActionForm>
  );
}
