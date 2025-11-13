import { Bot } from 'grammy';
import { BOT_TOKEN, ALLOWED_CHATS, LOG_CHAT_ID, ADMINS } from './config.js';
import { dbPromise, initDB, getWords } from './db.js';
import {
	updateProfanity,
	updateAd,
	updateCustom,
	checkProfanity,
	checkAd,
	checkCustom,
} from './filters.js';
import {
	FILTER_PROFANITY,
	FILTER_ADVERTISING,
	USE_NEURAL_NETWORK,
} from './state.js';
import { registerAdminPanel, initAdminDB } from './admin.js';
import { analyzeAllTopics, analyzeSequentially } from './neural.js';
import { DELETE_MESSAGES } from './state.js';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { InlineKeyboard } from 'grammy';
// Глобальная карта активных анализов
const activeAnalyses = new Map<
	number,
	{ cancel: boolean; controller: AbortController }
>();
async function main() {
	await initDB();
	await initAdminDB();

	console.log('ADMINS:', ADMINS);
	updateCustom(await getWords('custom_words'));
	const bot = new Bot(BOT_TOKEN);
	registerAdminPanel(bot);

	async function processDocument(ctx: any, bot: Bot) {
		try {
			console.log('🧾 processDocument вызван');
			const file = ctx.message?.document;
			if (!file) return;

			const fileName = file.file_name || 'без_имени';
			if (!fileName.endsWith('.html') && !fileName.endsWith('.json')) {
				await ctx.reply(
					`⚠️ Файл ${fileName} не поддерживается. Допустимые форматы: .html, .json`
				);
				return;
			}

			const fileInfo = await bot.api.getFile(file.file_id);
			if (!fileInfo.file_path) {
				await ctx.reply(
					'❌ Не удалось получить путь к файлу через Telegram API.'
				);
				return;
			}

			const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
			const response = await axios.get<ArrayBuffer>(fileUrl, {
				responseType: 'arraybuffer',
			});
			const bodyStr = Buffer.from(response.data).toString('utf-8');

			let messages: { author: string; text: string }[] = [];

			if (fileName.endsWith('.json')) {
				const data = JSON.parse(bodyStr);
				if (Array.isArray(data.messages)) {
					for (const msg of data.messages) {
						if (msg.from && msg.text) {
							let text = '';
							if (typeof msg.text === 'string') text = msg.text;
							else if (Array.isArray(msg.text))
								text = msg.text
									.map((t: any) => (typeof t === 'string' ? t : t.text))
									.join('');
							if (text.trim())
								messages.push({ author: msg.from, text: text.trim() });
						}
					}
				}
			} else {
				const $ = cheerio.load(bodyStr);
				$('div.message').each((_, el) => {
					const $el = $(el);
					const author =
						$el.find('.from_name').text().trim() ||
						$el.find('.from').text().trim();
					const text = $el.find('.text').text().trim();
					if (author && text) messages.push({ author, text });
				});
			}

			if (messages.length === 0) {
				await ctx.reply('⚠️ Не удалось извлечь сообщения из файла.');
				return;
			}

			const chatId = ctx.chat.id;

			if (activeAnalyses.has(chatId)) {
				await ctx.reply(
					'⚠️ Анализ уже выполняется. Отмени его или дождись завершения.'
				);
				return;
			}

			const controller = new AbortController();
			activeAnalyses.set(chatId, { cancel: false, controller });

			const cancelKeyboard = new InlineKeyboard().text(
				'🛑 Отменить анализ',
				`cancel_${chatId}`
			);
			await ctx.reply(
				`✅ Файл ${fileName} загружен. Найдено сообщений: ${messages.length}`,
				{
					reply_markup: cancelKeyboard,
				}
			);

			const violationsReport: string[] = [];

			// вспомогательная функция для проверки отмены
			const checkCancelled = () => {
				const analysis = activeAnalyses.get(chatId);
				if (!analysis || analysis.cancel) throw new Error('cancelled');
			};

			for (const [index, msg] of messages.entries()) {
				try {
					checkCancelled();

					const text = msg.text.toLowerCase();
					let violation: string | null = null;

					// Анализ нейросетью с возможностью прерывания
					if (USE_NEURAL_NETWORK && text.length > 3) {
						try {
							const neuralViolation = await analyzeSequentially(
								text,
								controller.signal
							);

							if (neuralViolation && typeof neuralViolation === 'object') {
								violation = `neural_${neuralViolation.topic}`;
							}
						} catch (err) {
							if (err instanceof Error && err.message === 'cancelled') {
								await ctx.reply('🛑 Анализ прерван пользователем.');
								activeAnalyses.delete(chatId);
								return;
							} else {
								console.error('Ошибка нейросети:', err);
							}
						}
					}

					// Проверки фильтров
					if (!violation) {
						if (FILTER_PROFANITY && checkProfanity(text))
							violation = 'violation_profanity';
						if (FILTER_ADVERTISING && checkAd(text)) violation = 'violation_ad';
						if (checkCustom(text)) violation = 'violation_custom';
					}

					function escapeMarkdownV2(str = '') {
						return str.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
					}

					if (violation) {
						violationsReport.push(
							`${index + 1}\\. 👤 *${escapeMarkdownV2(msg.author)}*\n` +
								`⚠️ *${escapeMarkdownV2(getViolationReason(violation))}*\n` +
								`💬 "${escapeMarkdownV2(msg.text)}"`
						);
					}

					if (index % 20 === 0) {
						await ctx.reply(
							`📊 Проверено ${index + 1} из ${messages.length} сообщений...`
						);
					}
				} catch (err) {
					if (err instanceof Error && err.message === 'cancelled') {
						await ctx.reply('🛑 Анализ прерван пользователем.');
						activeAnalyses.delete(chatId);
						return;
					} else {
						console.error('Ошибка при обработке сообщения:', err);
					}
				}
			}

			activeAnalyses.delete(chatId);
			await ctx.reply('✅ Анализ завершён.');

			async function safeReply(
				ctx: { reply: (arg0: string, arg1: { parse_mode: string }) => any },
				text: string | undefined
			) {
				const MAX_LENGTH = 4000;
				const safeText = text ?? '';
				for (let i = 0; i < safeText.length; i += MAX_LENGTH) {
					const chunk = safeText.slice(i, i + MAX_LENGTH);
					await ctx.reply(chunk, { parse_mode: 'MarkdownV2' });
				}
			}

			if (violationsReport.length > 0) {
				const chunkSize = 4000;
				let chunkText = '';
				for (const line of violationsReport) {
					if ((chunkText + '\n\n' + line).length > chunkSize) {
						await safeReply(ctx, chunkText);
						chunkText = line;
					} else {
						chunkText += (chunkText ? '\n\n' : '') + line;
					}
				}
				if (chunkText) await safeReply(ctx, chunkText);
			} else {
				await ctx.reply(`✅ В файле ${fileName} нарушений не найдено.`);
			}
		} catch (error: any) {
			console.error('❌ Ошибка в processDocument:', error);
			try {
				await ctx.reply('❌ Ошибка при анализе файла.');
			} catch {}
		}
	}

	async function checkBotPermissions(chatId: number): Promise<boolean> {
		try {
			const chatMember = await bot.api.getChatMember(
				chatId,
				(
					await bot.api.getMe()
				).id
			);
			if (chatMember.status === 'administrator') {
				const permissions = (chatMember as any).can_delete_messages;
				return permissions === true;
			}
			return false;
		} catch (error) {
			console.log('Бот не админ в чате:', chatId);
			return false;
		}
	}

	async function handleViolation(ctx: any, violationType: string) {
		const chatId = ctx.chat.id;
		const messageId = ctx.message.message_id;
		const userId = ctx.from.id;
		const text = ctx.message.text || ctx.message.caption || '';

		const db = await dbPromise;
		await db.run('INSERT INTO statistics (type,timestamp) VALUES (?,?)', [
			violationType,
			Math.floor(Date.now() / 1000),
		]);

		if (LOG_CHAT_ID) {
			try {
				await bot.api.sendMessage(
					LOG_CHAT_ID,
					`🚨 Нарушение!\n📌 Чат: ${chatId} (${
						ctx.chat.title || 'ЛС'
					})\n👤 Пользователь: ${
						ctx.from?.username ? '@' + ctx.from.username : ctx.from?.first_name
					} (${userId})\nТип нарушения: ${violationType}\nТекст: ${text}`
				);
				await bot.api.forwardMessage(LOG_CHAT_ID, chatId, messageId);
			} catch (err) {
				console.error('Ошибка при логировании нарушения:', err);
			}
		}

		try {
			const isAdmin = await checkBotPermissions(chatId);

			if (isAdmin && ctx.chat.type !== 'private') {
				if (DELETE_MESSAGES) {
					const warning = await ctx.reply(
						`⚠️ Сообщение от @${
							ctx.from.username || ctx.from.first_name
						} удалено.\nПричина: ${getViolationReason(violationType)}`
					);
					await bot.api.deleteMessage(chatId, messageId);
					setTimeout(async () => {
						try {
							await bot.api.deleteMessage(chatId, warning.message_id);
						} catch {}
					}, 10000);
				} else {
					console.log(
						`🚫 Нарушение у @${
							ctx.from.username || ctx.from.first_name
						}, но автоудаление отключено (${getViolationReason(violationType)})`
					);
				}
			} else if (ctx.chat.type === 'private') {
				await ctx.reply(
					`❌ Ваше сообщение содержит запрещённый контент. Причина: ${getViolationReason(
						violationType
					)}`
				);
			}
		} catch (error) {
			console.error('Ошибка при обработке нарушения:', error);
		}
	}

	function getViolationReason(type: string | null): string {
		if (!type) return 'нарушение правил';
		const reasons: Record<string, string> = {
			violation_profanity: 'ненормативная лексика',
			violation_ad: 'реклама',
			violation_custom: 'запрещенные слова',
			neural_bad_words: 'нежелательный контент (нейросеть)',
			neural_cars: 'автомобильная тема (нейросеть)',
			neural_advertising: 'реклама (нейросеть)',
		};
		return reasons[type] || 'нарушение правил';
	}

	let isCheckingChat = false;

	bot.command('check_chat', async ctx => {
		if (!ctx.from || !ADMINS.includes(ctx.from.id))
			return ctx.reply('❌ У тебя нет доступа к этой команде');
		isCheckingChat = true;
		await ctx.reply(
			'✅ Бот готов анализировать все сообщения, которые ты пришлёшь в ЛС.'
		);
	});

	bot.command('stop_check_chat', async ctx => {
		if (!ctx.from || !ADMINS.includes(ctx.from.id))
			return ctx.reply('❌ У тебя нет доступа к этой команде');
		isCheckingChat = false;
		await ctx.reply('🛑 Режим анализа отключён.');
	});

	bot.command('check_permissions', async ctx => {
		if (!ctx.from || !ADMINS.includes(ctx.from.id))
			return ctx.reply('❌ У тебя нет доступа к этой команде');
		if (ctx.chat.type === 'private')
			return ctx.reply('ℹ️ Эта команда работает только в группах и каналах');

		const hasPermissions = await checkBotPermissions(ctx.chat.id);
		if (hasPermissions)
			await ctx.reply('✅ Бот имеет необходимые права администратора');
		else
			await ctx.reply(
				'❌ Бот не имеет прав администратора или прав недостаточно. Требуются права на удаление сообщений.'
			);
	});
	bot.on('callback_query:data', async ctx => {
		const data = ctx.callbackQuery?.data;
		if (!data) return;

		if (data.startsWith('cancel_')) {
			const chatId = Number(data.split('_')[1]);
			const analysis = activeAnalyses.get(chatId);

			if (analysis && !analysis.cancel) {
				analysis.cancel = true;
				analysis.controller?.abort(); // 👈 реально прерывает axios.post
				await ctx.answerCallbackQuery({ text: '⏹ Анализ остановлен.' });
				await ctx.editMessageText('🛑 Анализ отменён пользователем.');
				activeAnalyses.delete(chatId); // 👈 чтобы не оставались “висячие” анализы
			} else {
				await ctx.answerCallbackQuery({
					text: '⚠️ Анализ не выполняется.',
					show_alert: false,
				});
			}
		}
	});

	bot.on('message', async ctx => {
		const chatId = ctx.chat.id;
		const msgText = ctx.message.text ?? ctx.message.caption ?? '';

		if (ctx.message.document) {
			const fromId = ctx.from?.id;
			const isAdminUser = typeof fromId === 'number' && ADMINS.includes(fromId);
			const isAllowedChat =
				ALLOWED_CHATS.length === 0 || ALLOWED_CHATS.includes(chatId);

			if (ctx.chat.type === 'private' && !isAdminUser) {
				await ctx.reply('❌ Анализ файлов доступен только администраторам.');
				return;
			}

			if (!isAdminUser && !isAllowedChat) {
				await ctx.reply(
					'❌ Этот чат не входит в список разрешённых для анализа файлов.'
				);
				return;
			}

			console.log('🔔 Обнаружен document — запускаем processDocument');
			await processDocument(ctx, bot);
			return;
		}

		const text = msgText.toLowerCase();
		let violation: string | null = null;

		if (USE_NEURAL_NETWORK && text.length > 3) {
			try {
				const neuralViolation = await analyzeSequentially(text);
				if (neuralViolation) violation = `neural_${neuralViolation.topic}`;
			} catch (err: unknown) {
				if (err instanceof Error) {
					if (err.message === 'cancelled') {
						await ctx.reply('🛑 Анализ прерван пользователем.');
						activeAnalyses.delete(chatId);
						return;
					} else {
						console.error('Ошибка нейросети:', err);
					}
				} else {
					console.error('Неизвестная ошибка:', err);
				}
			}
		}

		if (!violation) {
			if (FILTER_PROFANITY && checkProfanity(text))
				violation = 'violation_profanity';
			if (FILTER_ADVERTISING && checkAd(text)) violation = 'violation_ad';
			if (checkCustom(text)) violation = 'violation_custom';
		}

		if (violation) await handleViolation(ctx, violation);
		else {
			const db = await dbPromise;
			await db.run('INSERT INTO statistics (type,timestamp) VALUES (?,?)', [
				'message_ok',
				Math.floor(Date.now() / 1000),
			]);
		}

		if (
			isCheckingChat &&
			ctx.from &&
			ADMINS.includes(ctx.from.id) &&
			ctx.chat.type === 'private'
		) {
			if (!text) return ctx.reply('⚠️ Пустое сообщение — текст отсутствует.');
			let checkViolation: string | null = null;
			try {
				const neuralResults = await analyzeAllTopics(text);
				const neuralViolation = neuralResults.find(r => r.detected);
				if (neuralViolation) checkViolation = `neural_${neuralViolation.topic}`;
			} catch {}
			if (!checkViolation) {
				if (checkProfanity(text)) checkViolation = 'violation_profanity';
				if (checkAd(text)) checkViolation = 'violation_ad';
				if (checkCustom(text)) checkViolation = 'violation_custom';
			}
			if (checkViolation)
				await ctx.reply(
					`🚨 Обнаружено нарушение: ${getViolationReason(checkViolation)}`
				);
			else await ctx.reply('✅ Нарушений не обнаружено');
		}
	});

	bot.on('message:new_chat_members', async ctx => {
		// Можно добавить приветственное сообщение с правилами
	});

	bot.catch(err => {
		console.error('Ошибка бота:', err);
	});

	bot.start();
	console.log('Бот запущен 🚀');
}

main().catch(err => console.error('Ошибка в боте:', err));
