import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  primaryKey,
} from "drizzle-orm/pg-core";

export const contacts = pgTable("contacts", {
  id: serial("id").primaryKey(),
  firstname: text("firstname").notNull(),
  lastname: text("lastname").notNull(),
  email: text("email").notNull(),
  position: text("position"),
  company: text("company"),
  industry: text("industry"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const segments = pgTable("segments", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const contactSegments = pgTable(
  "contact_segments",
  {
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id),
    segmentId: integer("segment_id")
      .notNull()
      .references(() => segments.id),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.contactId, table.segmentId] }),
  })
);

export const campaigns = pgTable("campaigns", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  content: text("content").notNull(),
  segmentId: integer("segment_id")
    .notNull()
    .references(() => segments.id),
  status: text("status").notNull(),
  scheduledAt: timestamp("scheduled_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
