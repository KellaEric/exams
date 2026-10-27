// Applies pending SQL migrations and seeds reference data (roles, permissions, assessment categories, grading scale). Safe to re-run.
import { boot } from './_boot.js';
const { db } = await boot();
console.log('Database is up to date.');
await db.close();
