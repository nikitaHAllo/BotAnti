import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

export const dbPromise = open({
	filename: 'database.db',
	driver: sqlite3.Database,
});

export async function initDB() {
	const db = await dbPromise;
	await db.exec(`
        CREATE TABLE IF NOT EXISTS profanity_words (word TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS ad_keywords (word TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS custom_words (word TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS statistics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT,
            timestamp INTEGER
        );
        CREATE TABLE IF NOT EXISTS topics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            description TEXT,
            system_prompt TEXT,
            priority INTEGER,
            enabled INTEGER DEFAULT 1
        );
    `);
}

export async function addWord(
	table: 'profanity_words' | 'ad_keywords' | 'custom_words',
	word: string
) {
	const db = await dbPromise;
	await db.run(`INSERT OR IGNORE INTO ${table} (word) VALUES (?)`, [word]);
}

export async function deleteWord(
	table: 'profanity_words' | 'ad_keywords' | 'custom_words',
	word: string
) {
	const db = await dbPromise;
	await db.run(`DELETE FROM ${table} WHERE word = ?`, [word]);
}

export async function getWords(
	table: 'profanity_words' | 'ad_keywords' | 'custom_words'
): Promise<string[]> {
	const db = await dbPromise;
	const rows = (await db.all(`SELECT word FROM ${table}`)) as {
		word: string;
	}[];
	return rows.map(r => r.word.toLowerCase());
}
