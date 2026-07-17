/**
 * O RM entrega o nome completo (StudentName); o Toddle exige firstName E
 * lastName no POST /students. Convenção: primeiro token = firstName, resto =
 * lastName. Nome com um único token repete o valor (lastName é obrigatório).
 */
export function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/** Validação leve de e-mail: descarta lixo do cadastro sem derrubar o job. */
export function sanitizeEmail(value: string | null | undefined): string | undefined {
  const email = value?.trim();
  if (!email) return undefined;
  return /^\S+@\S+\.\S+$/.test(email) ? email : undefined;
}
