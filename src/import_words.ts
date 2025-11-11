import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

async function main() {
	const db = await open({
		filename: 'database.db',
		driver: sqlite3.Database,
	});

	await db.exec(`
    CREATE TABLE IF NOT EXISTS profanity_words (word TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS ad_keywords (word TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS statistics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      timestamp INTEGER
    );
  `);

	const profanityWords = (process.env.PROFANITY_WORDS || '')
		.split(',')
		.map(w => w.trim().toLowerCase())
		.filter(Boolean);

	const adWords = (process.env.AD_KEYWORDS || '')
		.split(',')
		.map(w => w.trim().toLowerCase())
		.filter(Boolean);

	const readmePath = './README.md';
	if (fs.existsSync(readmePath)) {
		const text = fs.readFileSync(readmePath, 'utf-8');
		const words =
			text.match(/\b[A-Za-zА-Яа-яЁё0-9-]{2,}\b/g)?.map(w => w.toLowerCase()) ||
			[];
		profanityWords.push(...words);
	}

	for (const word of profanityWords) {
		await db.run('INSERT OR IGNORE INTO profanity_words (word) VALUES (?)', [
			word,
		]);
	}
	for (const word of adWords) {
		await db.run('INSERT OR IGNORE INTO ad_keywords (word) VALUES (?)', [word]);
	}

	async function getCount(table: string): Promise<number> {
		const row = (await db.get(`SELECT COUNT(*) as c FROM ${table}`)) as
			| { c: number }
			| undefined;
		return row?.c ?? 0;
	}

	console.log(`✅ Загружено слов:`);
	console.log(`🚫 Брань: ${await getCount('profanity_words')}`);
	console.log(`📢 Реклама: ${await getCount('ad_keywords')}`);

	await db.close();
}

main().catch(err => {
	console.error('Ошибка при импорте слов:', err);
});
