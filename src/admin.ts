import { Bot, InlineKeyboard, Context } from 'grammy';
import { ADMINS, PROFANITY_WORDS, AD_KEYWORDS } from './config.js';
import { dbPromise, addWord, deleteWord, getWords } from './db.js';
import {
	updateProfanity,
	updateAd,
	updateCustom,
	profanityWords,
	adWords,
	customWords,
} from './filters.js';
import {
	FILTER_PROFANITY,
	FILTER_ADVERTISING,
	USE_NEURAL_NETWORK,
	DELETE_MESSAGES,
	toggleProfanity,
	toggleAdvertising,
	toggleNeuralNetwork,
	toggleDeleteMessages,
	getCurrentModel,
	setCurrentModel,
} from './state.js';

import {
	analyzeAllTopics,
	AVAILABLE_MODELS,
	getActiveTopics,
	toggleTopic,
	TOPICS,
	getTopicsByPriority,
} from './neural.js';

export async function initAdminDB() {
	const profanity = await getWords('profanity_words');
	const ad = await getWords('ad_keywords');
	const custom = await getWords('custom_words');

	if (profanity.length === 0 && PROFANITY_WORDS.length > 0) {
		for (const word of PROFANITY_WORDS) await addWord('profanity_words', word);
	}
	if (ad.length === 0 && AD_KEYWORDS.length > 0) {
		for (const word of AD_KEYWORDS) await addWord('ad_keywords', word);
	}

	updateProfanity(await getWords('profanity_words'));
	updateAd(await getWords('ad_keywords'));
	updateCustom(await getWords('custom_words'));
}

function mainAdminKeyboard() {
	const currentModel = getCurrentModel();
	const shortModel = currentModel.split(':')[0];

	return new InlineKeyboard()

		.text(`${DELETE_MESSAGES ? '✅' : '❌'} Удаление`, 'toggle_delete')
		.row()
		.text(`${FILTER_PROFANITY ? '✅' : '❌'} Брань`, 'toggle_profanity')
		.row()
		.text(`${FILTER_ADVERTISING ? '✅' : '❌'} Реклама`, 'toggle_ad')
		.row()
		.text(`${USE_NEURAL_NETWORK ? '✅' : '❌'} Нейросеть`, 'toggle_neural')
		.row()
		.row()
		.text(`🤖 ${shortModel}`, 'neural_models')
		.row()
		.text('📊 Статистика', 'show_statistics')
		.row()
		.text('📝 Список слов', 'list_words')
		.row()
		.text('📜 Команды', 'show_commands');
}

function backToAdminKeyboard() {
	return new InlineKeyboard().text('⬅️ Назад в панель', 'back_to_admin');
}

function neuralModelsKeyboard() {
	const keyboard = new InlineKeyboard();
	const currentModel = getCurrentModel();

	AVAILABLE_MODELS.forEach((model, index) => {
		const isCurrent = model === currentModel;
		const shortName = model.split(':')[0];

		const modelId = model.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
		const callbackData = `model_${modelId}`;

		keyboard.text(`${isCurrent ? '✅' : '🔘'} ${shortName}`, callbackData);
		if (index % 2 === 1) keyboard.row();
	});

	keyboard.row().text('⬅️ Назад', 'back_to_admin');
	return keyboard;
}

function neuralTopicsKeyboard() {
	const keyboard = new InlineKeyboard();
	const sortedTopics = getTopicsByPriority();

	sortedTopics.forEach((topic, index) => {
		const callbackData = `topic_${topic.name}`;
		keyboard.text(
			`${topic.enabled ? '✅' : '❌'} ${topic.name} (${topic.priority})`,
			callbackData
		);
		if (index % 2 === 1) keyboard.row();
	});

	keyboard.row().text('⬅️ Назад', 'back_to_admin');
	return keyboard;
}

export function registerAdminPanel(bot: Bot<Context>) {
	bot.command('admin', async ctx => {
		if (!ctx.from || !ADMINS.includes(ctx.from.id)) return;
		if (!ctx.chat || ctx.chat.type !== 'private') {
			return ctx.reply('⚠️ Админ-панель доступна только в личке с ботом');
		}

		await ctx.reply('Панель администратора:', {
			reply_markup: mainAdminKeyboard(),
		});
	});

	bot.on('callback_query:data', async ctx => {
		if (!ctx.from || !ADMINS.includes(ctx.from.id)) {
			return ctx.answerCallbackQuery({ text: 'Нет доступа', show_alert: true });
		}

		const db = await dbPromise;
		const data = ctx.callbackQuery?.data;
		if (!data) return;

		switch (data) {
			case 'toggle_delete':
				await ctx.editMessageText(
					`Фильтр удаления: ${toggleDeleteMessages() ? '✅ Вкл' : '❌ Выкл'}`,
					{ reply_markup: backToAdminKeyboard() }
				);
				break;
			case 'toggle_profanity':
				await ctx.editMessageText(
					`Фильтр брани: ${toggleProfanity() ? '✅ Вкл' : '❌ Выкл'}`,
					{ reply_markup: backToAdminKeyboard() }
				);
				break;

			case 'toggle_ad':
				await ctx.editMessageText(
					`Фильтр рекламы: ${toggleAdvertising() ? '✅ Вкл' : '❌ Выкл'}`,
					{ reply_markup: backToAdminKeyboard() }
				);
				break;

			case 'toggle_neural':
				await ctx.editMessageText(
					`Нейросеть: ${toggleNeuralNetwork() ? '✅ Вкл' : '❌ Выкл'}`,
					{ reply_markup: backToAdminKeyboard() }
				);
				break;

			case 'neural_topics':
				const sortedTopics = getTopicsByPriority();
				const topicsText = sortedTopics
					.map(
						(topic: any) =>
							`• ${topic.name}: ${topic.enabled ? '✅' : '❌'} (приоритет: ${
								topic.priority
							})`
					)
					.join('\n');

				await ctx.editMessageText(
					`🧠 Управление тематиками (проверяются последовательно):\n\n${topicsText}\n\nНажмите на тему чтобы включить/выключить:`,
					{ reply_markup: neuralTopicsKeyboard() }
				);
				break;

			case 'neural_models':
				const currentModel = getCurrentModel();
				await ctx.editMessageText(
					`🤖 Выбор модели нейросети:\n\nТекущая модель: ${currentModel}\n\nВыберите модель:`,
					{ reply_markup: neuralModelsKeyboard() }
				);
				break;

			case 'show_statistics': {
				const now = Math.floor(Date.now() / 1000);
				const oneHourAgo = now - 3600;
				const oneWeekAgo = now - 7 * 24 * 3600;
				const getCount = async (q: string, p: any[] = []) =>
					((await db.get(q, p)) as { c: number } | undefined)?.c ?? 0;

				const lastHour = await getCount(
					'SELECT COUNT(*) as c FROM statistics WHERE timestamp > ?',
					[oneHourAgo]
				);
				const lastWeek = await getCount(
					'SELECT COUNT(*) as c FROM statistics WHERE timestamp > ?',
					[oneWeekAgo]
				);
				const allTime = await getCount('SELECT COUNT(*) as c FROM statistics');
				const violationsAll = await getCount(
					"SELECT COUNT(*) as c FROM statistics WHERE type IN ('violation_ad','violation_profanity','violation_custom','neural_bad_words','neural_cars','neural_advertising')"
				);
				const neuralViolations = await getCount(
					"SELECT COUNT(*) as c FROM statistics WHERE type LIKE 'neural_%'"
				);

				await ctx.editMessageText(
					`📊 Статистика:\nПоследний час: ${lastHour}\nПоследняя неделя: ${lastWeek}\nВсего: ${allTime} (нарушений: ${violationsAll})\n🧠 Нарушений нейросети: ${neuralViolations}`,
					{ reply_markup: backToAdminKeyboard() }
				);
				break;
			}

			case 'list_words':
				const activeTopicsList = getActiveTopics();
				const neuralInfo =
					activeTopicsList.length > 0
						? activeTopicsList
								.map(t => `${t.name} (приоритет: ${t.priority})`)
								.join('\n')
						: 'нет активных тематик';

				await ctx.editMessageText(
					`📝 Список слов:\n🚫 Брань: ${
						[...profanityWords].join(', ') || 'нет'
					}\n📢 Реклама: ${
						[...adWords].join(', ') || 'нет'
					}\n🧩 Пользовательские: ${
						[...customWords].join(', ') || 'нет'
					}\n\n🧠 Тематики нейросети:\n${neuralInfo}`,
					{ reply_markup: backToAdminKeyboard() }
				);
				break;

			case 'show_commands':
				await ctx.editMessageText(
					`📜 Команды администратора:\n\n` +
						`/admin - панель управления\n` +
						`/check_chat - анализ ЛС\n` +
						`/test_neural <текст> - тест нейросети\n` +
						`/models - список моделей\n` +
						`/neural_stats - статистика нейросети\n\n` +
						`📝 Управление словами:\n` +
						`/add_profanity <слово>\n` +
						`/del_profanity <слово>\n` +
						`/add_ad <слово>\n` +
						`/del_ad <слово>\n` +
						`/add_custom <слово>\n` +
						`/del_custom <слово>\n\n` +
						`🗂️ Управление темами:\n` +
						`/add_topic <имя> | <описание> | <приоритет>\n` +
						`/del_topic <имя>`,

					{ reply_markup: backToAdminKeyboard() }
				);
				break;

			case 'back_to_admin':
				await ctx.editMessageText('Панель администратора:', {
					reply_markup: mainAdminKeyboard(),
				});
				break;

			default:
				if (data.startsWith('topic_')) {
					const topicName = data.replace('topic_', '');
					const topic = TOPICS.find(t => t.name === topicName);
					if (topic) {
						topic.enabled = !topic.enabled;
						await ctx.editMessageText(
							`Тематика "${topicName}": ${
								topic.enabled ? '✅ Вкл' : '❌ Выкл'
							}`,
							{ reply_markup: neuralTopicsKeyboard() }
						);
					}
				}

				if (data.startsWith('model_')) {
					const modelId = data.replace('model_', '');

					const model = AVAILABLE_MODELS.find(
						m => m.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30) === modelId
					);

					if (model) {
						setCurrentModel(model);
						await ctx.editMessageText(`✅ Модель изменена на: ${model}`, {
							reply_markup: neuralModelsKeyboard(),
						});
					} else {
						await ctx.answerCallbackQuery({
							text: 'Модель не найдена',
							show_alert: true,
						});
					}
				}
				break;
		}

		await ctx.answerCallbackQuery();
	});

	bot.command('neural_stats', async ctx => {
		if (!ctx.from || !ADMINS.includes(ctx.from.id)) return;

		const activeTopics = getActiveTopics();
		const inactiveTopics = TOPICS.filter(topic => !topic.enabled);
		const currentModel = getCurrentModel();

		const statsText = activeTopics
			.map(topic => `• ${topic.name}: ✅ (приоритет: ${topic.priority})`)
			.join('\n');

		const inactiveText = inactiveTopics
			.map(topic => `• ${topic.name}: ❌`)
			.join('\n');

		await ctx.reply(
			`🧠 Статистика нейросети:\n\n` +
				`Модель: ${currentModel}\n` +
				`Состояние: ${USE_NEURAL_NETWORK ? '✅ Активна' : '❌ Выключена'}\n\n` +
				`Активные тематики:\n${statsText}\n\n` +
				`Неактивные тематики:\n${inactiveText || 'нет'}`
		);
	});

	bot.command('test_neural', async ctx => {
		if (!ctx.from || !ADMINS.includes(ctx.from.id)) return;

		const text = ctx.message?.text?.split(' ').slice(1).join(' ');
		if (!text) {
			return ctx.reply('❌ Укажите текст: /test_neural ваш текст');
		}

		await ctx.reply(`🧠 Тестирую нейросеть с текстом: "${text}"`);

		try {
			const results = await analyzeAllTopics(text);

			let response = `📊 Результаты анализа:\n\n`;

			results.forEach(result => {
				response += `• ${result.topic}: ${
					result.detected ? '🚨 ДА' : '✅ НЕТ'
				}\n`;
				if (result.reason) {
					response += `  Ответ: ${result.reason}\n`;
				}
				response += '\n';
			});

			await ctx.reply(response);
		} catch (error: any) {
			await ctx.reply(`❌ Ошибка: ${error.message}`);
		}
	});

	bot.command('models', async ctx => {
		if (!ctx.from || !ADMINS.includes(ctx.from.id)) return;

		const currentModel = getCurrentModel();
		let response = `🤖 Доступные модели:\n\n`;

		AVAILABLE_MODELS.forEach(model => {
			response += `${model === currentModel ? '✅' : '🔘'} ${model}\n`;
		});

		response += `\nТекущая: ${currentModel}\n`;
		response += `Изменить: /admin → "Модели"`;

		await ctx.reply(response);
	});

	['profanity', 'ad'].forEach(type => {
		const table = type === 'profanity' ? 'profanity_words' : 'ad_keywords';

		bot.command(`add_${type}`, async ctx => {
			if (!ctx.from || !ADMINS.includes(ctx.from.id)) return;

			const text = ctx.message?.text;
			if (!text) return ctx.reply(`❌ Укажи слово: /add_${type} слово`);

			const word = text.split(' ').slice(1).join(' ').toLowerCase();
			if (!word) return ctx.reply(`❌ Укажи слово: /add_${type} слово`);

			await addWord(table, word);
			type === 'profanity'
				? updateProfanity(await getWords(table))
				: updateAd(await getWords(table));

			await ctx.reply(`✅ Добавлено слово: ${word}`);
		});

		bot.command(`del_${type}`, async ctx => {
			if (!ctx.from || !ADMINS.includes(ctx.from.id)) return;

			const text = ctx.message?.text;
			if (!text) return ctx.reply(`❌ Укажи слово: /del_${type} слово`);

			const word = text.split(' ').slice(1).join(' ').toLowerCase();
			if (!word) return ctx.reply(`❌ Укажи слово: /del_${type} слово`);

			await deleteWord(table, word);
			type === 'profanity'
				? updateProfanity(await getWords(table))
				: updateAd(await getWords(table));

			await ctx.reply(`✅ Удалено слово: ${word}`);
		});
	});

	bot.command('add_custom', async ctx => {
		if (!ctx.from || !ADMINS.includes(ctx.from.id)) return;

		const text = ctx.message?.text;
		if (!text) return ctx.reply('❌ Укажи слово: /add_custom слово');

		const word = text.split(' ').slice(1).join(' ').toLowerCase();
		if (!word) return ctx.reply('❌ Укажи слово: /add_custom слово');

		await addWord('custom_words', word);
		updateCustom(await getWords('custom_words'));
		await ctx.reply(`✅ Добавлено слово в фильтр: ${word}`);
	});

	bot.command('del_custom', async ctx => {
		if (!ctx.from || !ADMINS.includes(ctx.from.id)) return;

		const text = ctx.message?.text;
		if (!text) return ctx.reply('❌ Укажи слово: /del_custom слово');

		const word = text.split(' ').slice(1).join(' ').toLowerCase();
		if (!word) return ctx.reply('❌ Укажи слово: /del_custom слово');

		await deleteWord('custom_words', word);
		updateCustom(await getWords('custom_words'));
		await ctx.reply(`✅ Удалено слово из фильтра: ${word}`);
	});
	bot.command('add_topic', async ctx => {
		if (!ctx.from || !ADMINS.includes(ctx.from.id)) return;

		const text = ctx.message?.text;
		if (!text)
			return ctx.reply(
				'❌ Укажи данные: /add_topic <имя> | <описание> | <приоритет>'
			);

		const parts = text.split('|').map(p => p.trim());
		if (parts.length < 3) {
			return ctx.reply(
				'❌ Формат: /add_topic <имя> | <описание> | <приоритет>'
			);
		}

		const [nameRaw, description, priorityRaw] = parts;
		const name = nameRaw.split(' ')[1]?.toLowerCase() || nameRaw.toLowerCase();
		const priority = parseInt(priorityRaw, 10);

		if (!name || !description || isNaN(priority)) {
			return ctx.reply(
				'❌ Формат: /add_topic <имя> | <описание> | <приоритет>'
			);
		}

		if (TOPICS.find(t => t.name === name)) {
			return ctx.reply(`⚠️ Тематика "${name}" уже существует.`);
		}

		const db = await dbPromise;

		await db.run(`
		CREATE TABLE IF NOT EXISTS topics (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT UNIQUE,
			description TEXT,
			priority INTEGER,
			enabled INTEGER DEFAULT 1
		)
	`);

		await db.run(
			`INSERT OR IGNORE INTO topics (name, description, priority, enabled) VALUES (?, ?, ?, 1)`,
			[name, description, priority]
		);

		TOPICS.push({
			name,
			systemPrompt: `Ты — анализатор темы "${name}". Твоя задача — определить, относится ли сообщение к следующему описанию:\n${description}\n\nЕсли относится — ответь "ДА", если нет — ответь "НЕТ".`,
			keywords: [],
			priority,
			enabled: true,
		});

		await ctx.reply(
			`✅ Добавлена новая тематика нейросети:\n\n` +
				`• Название: ${name}\n` +
				`• Приоритет: ${priority}\n` +
				`• Описание: ${description}`
		);
	});

	bot.command('del_topic', async ctx => {
		if (!ctx.from || !ADMINS.includes(ctx.from.id)) return;

		const text = ctx.message?.text;
		if (!text) return ctx.reply('❌ Укажи имя темы: /del_topic <имя>');

		const name = text.split(' ')[1]?.trim()?.toLowerCase();
		if (!name) return ctx.reply('❌ Укажи имя темы: /del_topic <имя>');

		const db = await dbPromise;

		const result = await db.run(`DELETE FROM topics WHERE name = ?`, [name]);

		const index = TOPICS.findIndex(t => t.name === name);
		if (index === -1) {
			return ctx.reply(`⚠️ Тематика "${name}" не найдена.`);
		}

		TOPICS.splice(index, 1);

		if ((result.changes ?? 0) > 0) {
			await ctx.reply(`🗑 Тематика "${name}" удалена из базы и памяти.`);
		} else {
			await ctx.reply(
				`⚠️ Тематика "${name}" не найдена в базе, но удалена из памяти.`
			);
		}
	});
}
