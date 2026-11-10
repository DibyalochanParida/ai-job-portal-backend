import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { getDb, query } from "../db/index.js";
import { badRequest, conflict, notFound, unauthorized } from "../lib/errors.js";
import { currentUser, requireAuth, signToken, type Role } from "../middleware/auth.js";
import { authLimiter } from "../middleware/rateLimit.js";
import { body } from "../middleware/validate.js";

const router = Router();

const password = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128)
  .regex(/[A-Za-z]/, "Password must contain a letter")
  .regex(/\d/, "Password must contain a number");

const RegisterSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("seeker"),
    email: z.email().max(254),
    password,
    fullName: z.string().trim().min(2).max(120),
  }),
  z.object({
    role: z.literal("employer"),
    email: z.email().max(254),
    password,
    fullName: z.string().trim().min(2).max(120),
    companyName: z.string().trim().min(2).max(160),
    companyWebsite: z.url().max(300).optional().or(z.literal("")),
    companyIndustry: z.string().trim().max(120).optional(),
    companySize: z.string().trim().max(40).optional(),
  }),
]);

// Compared against when the email is unknown, so response time does not reveal which emails exist.
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= bcrypt.hash("timing-equaliser-not-a-password", 12));

const LoginSchema = z.object({ email: z.email(), password: z.string().min(1).max(128) });

interface UserRow {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  passwordHash?: string;
  createdAt: Date;
}

async function loadProfile(userId: string) {
  const { rows } = await query<UserRow & { company: Record<string, unknown> | null }>(
    `SELECT u.id, u.email, u.full_name AS "fullName", u.role, u.created_at AS "createdAt",
            CASE WHEN c.id IS NULL THEN NULL ELSE json_build_object('id', c.id, 'name', c.name, 'website', c.website,
              'industry', c.industry, 'size', c.size, 'description', c.description) END AS company
     FROM users u LEFT JOIN companies c ON c.owner_id = u.id WHERE u.id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

router.post("/register", authLimiter, async (req, res) => {
  const input = body(req, RegisterSchema);
  const email = input.email.toLowerCase();
  const existing = await query("SELECT 1 FROM users WHERE lower(email) = $1", [email]);
  if (existing.rowCount) throw conflict("An account with this email already exists");

  const passwordHash = await bcrypt.hash(input.password, 12);
  const userId = await getDb().transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "INSERT INTO users (email, password_hash, full_name, role) VALUES ($1,$2,$3,$4) RETURNING id",
      [email, passwordHash, input.fullName, input.role],
    );
    const id = rows[0]!.id;
    if (input.role === "employer") {
      await tx.query("INSERT INTO companies (owner_id, name, website, industry, size) VALUES ($1,$2,$3,$4,$5)", [
        id,
        input.companyName,
        input.companyWebsite || null,
        input.companyIndustry ?? null,
        input.companySize ?? null,
      ]);
    }
    return id;
  });

  const user = await loadProfile(userId);
  res.status(201).json({ token: signToken({ id: userId, role: input.role }), user });
});

router.post("/login", authLimiter, async (req, res) => {
  const { email, password: pw } = body(req, LoginSchema);
  const { rows } = await query<UserRow>(
    `SELECT id, role, password_hash AS "passwordHash" FROM users WHERE lower(email) = $1`,
    [email.toLowerCase()],
  );
  const row = rows[0];
  const ok = await bcrypt.compare(pw, row?.passwordHash ?? (await getDummyHash()));
  if (!row || !ok) throw unauthorized("Invalid email or password");
  const user = await loadProfile(row.id);
  res.json({ token: signToken({ id: row.id, role: row.role }), user });
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await loadProfile(currentUser(req).id);
  if (!user) throw notFound("User");
  res.json({ user });
});

const CompanySchema = z.object({
  name: z.string().trim().min(2).max(160),
  website: z.url().max(300).nullable().optional().or(z.literal("")),
  industry: z.string().trim().max(120).nullable().optional(),
  size: z.string().trim().max(40).nullable().optional(),
  description: z.string().trim().max(5000).nullable().optional(),
});

router.patch("/company", requireAuth, async (req, res) => {
  const me = currentUser(req);
  if (me.role !== "employer") throw badRequest("Only employer accounts have a company profile");
  const input = body(req, CompanySchema);
  await query(
    "UPDATE companies SET name=$2, website=$3, industry=$4, size=$5, description=$6 WHERE owner_id=$1",
    [me.id, input.name, input.website || null, input.industry ?? null, input.size ?? null, input.description ?? null],
  );
  res.json({ user: await loadProfile(me.id) });
});

export default router;
