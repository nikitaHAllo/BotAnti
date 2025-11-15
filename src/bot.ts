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

// Глобальная карта загруженных сообщений, ожидающих выбора количества
const pendingMessages = new Map<
	number,
	{ messages: { author: string; text: string }[]; fileName: string }
>();
async function main() {
	await initDB();
	await initAdminDB();

	console.log('ADMINS:', ADMINS);
	updateCustom(await getWords('custom_words'));
	const bot = new Bot(BOT_TOKEN);
	registerAdminPanel(bot);

	const allMessages: { author: string; text: string }[] = [];
	let totalFilesProcessed = 0;
	async function processDocument(ctx: any, bot: Bot) {
		try {
			console.log('🧾 processDocument вызван');
			const file = ctx.message?.document;
			if (!file) {
				console.log('⚠️ Документ не найден в сообщении');
				return;
			}
			console.log(`📄 Файл: ${file.file_name}, ID: ${file.file_id}`);

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
				let currentAuthor = '';
				$('div.message').each((_, el) => {
					const $el = $(el);
					const author =
						$el.find('.from_name').text().trim() ||
						$el.find('.from').text().trim();

					if (author) {
						currentAuthor = author;
					}

					const text = $el.find('.text').text().trim();
					if (currentAuthor && text) {
						messages.push({ author: currentAuthor, text });
					}
				});
			}

			allMessages.push(...messages);
			totalFilesProcessed++;
			if (messages.length === 0) {
				console.log('⚠️ Сообщения не найдены в файле');
				await ctx.reply('⚠️ Не удалось извлечь сообщения из файла.');
				return;
			}

			console.log(`✅ Извлечено сообщений: ${messages.length}`);

			const chatId = ctx.chat.id;
			console.log(`📌 Chat ID: ${chatId}`);

			if (activeAnalyses.has(chatId)) {
				console.log('⚠️ Анализ уже выполняется для этого чата');
				await ctx.reply(
					'⚠️ Анализ уже выполняется. Отмени его или дождись завершения.'
				);
				return;
			}

			// // Сохраняем сообщения для выбора количества
			// pendingMessages.set(chatId, { messages, fileName });
			// console.log(`💾 Сообщения сохранены для чата ${chatId}`);

			await ctx.reply(
				`✅ Файл ${fileName} загружен!\n` +
					`📨 Сообщений из файла: ${messages.length}\n` +
					`📊 Всего сообщений: ${allMessages.length}\n` +
					`📁 Обработано файлов: ${totalFilesProcessed}\n\n` +
					`Для анализа всех сообщений используйте команду /analyze`
			);
		} catch (error: any) {
			console.error('❌ Ошибка в processDocument:', error);
			console.error('❌ Стек ошибки:', error.stack);
			try {
				await ctx.reply(
					`❌ Ошибка при анализе файла: ${
						error.message || 'Неизвестная ошибка'
					}`
				);
			} catch (replyError) {
				console.error(
					'❌ Ошибка при отправке сообщения об ошибке:',
					replyError
				);
			}
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
	// Функция для запуска анализа с ограничением количества сообщений
	async function startAnalysis(
		ctx: any,
		chatId: number,
		messages: { author: string; text: string }[],
		fileName: string,
		limit: number | null
	) {
		console.log(
			`🚀 startAnalysis вызвана для чата ${chatId}, сообщений: ${messages.length}, лимит: ${limit}`
		);
		const messagesToAnalyze =
			limit !== null ? messages.slice(0, limit) : messages;
		console.log(
			`📊 Будет проанализировано: ${messagesToAnalyze.length} сообщений`
		);
		console.log(
			`🧠 Состояние нейросети: USE_NEURAL_NETWORK=${USE_NEURAL_NETWORK}`
		);

		if (activeAnalyses.has(chatId)) {
			console.log('⚠️ Анализ уже выполняется для этого чата');
			await ctx.reply(
				'⚠️ Анализ уже выполняется. Отмени его или дождись завершения.'
			);
			return;
		}

		// Создаем клавиатуру для выбора количества сообщений из общего массива
		const callbackAll = `analyze_limit_${chatId}_all`;
		const callback500 = `analyze_limit_${chatId}_500`;
		const callback1000 = `analyze_limit_${chatId}_1000`;
		const callback2000 = `analyze_limit_${chatId}_2000`;
		const callback5000 = `analyze_limit_${chatId}_5000`;
		const callback10000 = `analyze_limit_${chatId}_10000`;
		const callbackCustom = `analyze_limit_${chatId}_custom`;

		console.log(
			`🔑 Callback data для кнопок: all=${callbackAll}, 500=${callback500}, custom=${callbackCustom}`
		);

		const limitKeyboard = new InlineKeyboard()
			.text('📊 Все сообщения', callbackAll)
			.row()
			.text('500', callback500)
			.text('1000', callback1000)
			.row()
			.text('2000', callback2000)
			.text('5000', callback5000)
			.row()
			.text('10000', callback10000)
			.row()
			.text('✏️ Ввести число', callbackCustom);

		console.log('📤 Отправляю сообщение с клавиатурой выбора...');

		await ctx.reply(
			`📊 Готов к анализу!\n` +
				`📁 Обработано файлов: ${totalFilesProcessed}\n` +
				`📨 Всего сообщений: ${allMessages.length}\n\n` +
				`Выберите, сколько сообщений анализировать:`,
			{
				reply_markup: limitKeyboard,
			}
		);

		// Сохраняем общий массив для этого чата
		pendingMessages.set(chatId, {
			messages: allMessages,
			fileName: `все_файлы_(${totalFilesProcessed})`,
		});

		const controller = new AbortController();
		activeAnalyses.set(chatId, { cancel: false, controller });
		console.log('✅ Анализ добавлен в activeAnalyses');

		const cancelKeyboard = new InlineKeyboard().text(
			'🛑 Отменить анализ',
			`cancel_${chatId}`
		);

		// Отправляем начальное сообщение и сохраняем его ID
		console.log('📤 Отправляю начальное сообщение о прогрессе...');
		const startMessage = await ctx.reply(
			`🔍 Начинаю анализ ${messagesToAnalyze.length} из ${messages.length} сообщений...\n\n📊 Проанализировано: 0 из ${messagesToAnalyze.length}\n⏱ Время: 0 секунд`,
			{
				reply_markup: cancelKeyboard,
			}
		);
		console.log(
			`✅ Начальное сообщение отправлено, ID: ${startMessage.message_id}`
		);

		const startTime = Date.now();
		const progressMessageId = startMessage.message_id;
		let lastUpdateTime = 0;
		const UPDATE_INTERVAL = 1000; // Обновлять каждую секунду
		console.log('🔄 Начинаю цикл анализа сообщений...');

		const violationsReport: string[] = [];

		// Функция для обновления сообщения о прогрессе
		const updateProgress = async (current: number, total: number) => {
			const now = Date.now();
			// Обновляем не чаще раза в секунду
			if (now - lastUpdateTime < UPDATE_INTERVAL && current < total) {
				return;
			}
			lastUpdateTime = now;

			const elapsed = Math.floor((now - startTime) / 1000);
			const speed =
				elapsed > 0 && current > 0 ? Math.round(current / elapsed) : 0;
			const progressText =
				`🔍 Анализ в процессе...\n\n` +
				`📊 Проанализировано: ${current} из ${total}\n` +
				`⏱ Время: ${elapsed} секунд${
					speed > 0 ? `\n⚡ Скорость: ${speed} сообщ/сек` : ''
				}`;

			try {
				await ctx.api.editMessageText(chatId, progressMessageId, progressText, {
					reply_markup: cancelKeyboard,
				});
			} catch (err) {
				// Игнорируем ошибки редактирования (например, если сообщение было удалено)
				console.error('Ошибка обновления прогресса:', err);
			}
		};

		// вспомогательная функция для проверки отмены
		const checkCancelled = () => {
			const analysis = activeAnalyses.get(chatId);
			if (!analysis || analysis.cancel) throw new Error('cancelled');
		};

		for (const [index, msg] of messagesToAnalyze.entries()) {
			try {
				checkCancelled();

				const text = msg.text.toLowerCase();
				let violation: string | null = null;

				// Анализ нейросетью с возможностью прерывания
				if (USE_NEURAL_NETWORK && text.length > 3) {
					if (index === 0 || index % 100 === 0) {
						console.log(
							`🧠 [${index + 1}/${
								messagesToAnalyze.length
							}] Вызываю нейросеть для анализа: "${text.substring(0, 50)}..."`
						);
					}
					try {
						const neuralViolation = await analyzeSequentially(
							text,
							controller.signal
						);

						if (neuralViolation && typeof neuralViolation === 'object') {
							console.log(
								`🚨 [${index + 1}] Нейросеть обнаружила нарушение: ${
									neuralViolation.topic
								}`
							);
							violation = `neural_${neuralViolation.topic}`;
						} else if (index === 0 || index % 100 === 0) {
							console.log(
								`✅ [${index + 1}] Нейросеть не обнаружила нарушений`
							);
						}
					} catch (err) {
						if (err instanceof Error && err.message === 'cancelled') {
							const elapsed = Math.floor((Date.now() - startTime) / 1000);
							await ctx.api.editMessageText(
								chatId,
								progressMessageId,
								`🛑 Анализ прерван пользователем.\n\n📊 Проанализировано: ${index} из ${messagesToAnalyze.length}\n⏱ Время: ${elapsed} секунд`
							);
							activeAnalyses.delete(chatId);
							return;
						} else {
							console.error(
								`❌ Ошибка нейросети при анализе сообщения ${index + 1}:`,
								err
							);
						}
					}
				} else {
					if (index === 0) {
						console.log(
							`⚠️ Нейросеть не вызывается: USE_NEURAL_NETWORK=${USE_NEURAL_NETWORK}, text.length=${text.length}`
						);
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

				// Обновляем прогресс каждые 5 сообщений или на последнем
				if (index % 5 === 0 || index === messagesToAnalyze.length - 1) {
					await updateProgress(index + 1, messagesToAnalyze.length);
				}
			} catch (err) {
				if (err instanceof Error && err.message === 'cancelled') {
					const elapsed = Math.floor((Date.now() - startTime) / 1000);
					await ctx.api.editMessageText(
						chatId,
						progressMessageId,
						`🛑 Анализ прерван пользователем.\n\n📊 Проанализировано: ${index} из ${messagesToAnalyze.length}\n⏱ Время: ${elapsed} секунд`
					);
					activeAnalyses.delete(chatId);
					return;
				} else {
					console.error('Ошибка при обработке сообщения:', err);
				}
			}
		}

		activeAnalyses.delete(chatId);
		const elapsed = Math.floor((Date.now() - startTime) / 1000);
		const speed =
			elapsed > 0
				? Math.round(messagesToAnalyze.length / elapsed)
				: messagesToAnalyze.length;
		try {
			await ctx.api.editMessageText(
				chatId,
				progressMessageId,
				`✅ Анализ завершён.\n\n📊 Проанализировано: ${messagesToAnalyze.length} из ${messagesToAnalyze.length}\n⏱ Время: ${elapsed} секунд\n⚡ Скорость: ${speed} сообщ/сек`
			);
			allMessages.length = 0;
			totalFilesProcessed = 0;
		} catch (err) {
			console.error('Ошибка обновления финального сообщения:', err);
		}

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
	}

	async function startAnalysisFromAllMessages(ctx: any) {
		try {
			if (allMessages.length === 0) {
				await ctx.reply(
					'📭 Нет сообщений для анализа. Сначала загрузите файлы.'
				);
				return;
			}

			const chatId = ctx.chat.id;
			console.log(`📌 Chat ID: ${chatId}`);

			if (activeAnalyses.has(chatId)) {
				console.log('⚠️ Анализ уже выполняется для этого чата');
				await ctx.reply(
					'⚠️ Анализ уже выполняется. Отмени его или дождись завершения.'
				);
				return;
			}

			// Создаем клавиатуру для выбора количества сообщений из общего массива
			const callbackAll = `analyze_limit_${chatId}_all`;
			const callback500 = `analyze_limit_${chatId}_500`;
			const callback1000 = `analyze_limit_${chatId}_1000`;
			const callback2000 = `analyze_limit_${chatId}_2000`;
			const callback5000 = `analyze_limit_${chatId}_5000`;
			const callback10000 = `analyze_limit_${chatId}_10000`;
			const callbackCustom = `analyze_limit_${chatId}_custom`;

			console.log(
				`🔑 Callback data для кнопок: all=${callbackAll}, 500=${callback500}, custom=${callbackCustom}`
			);

			const limitKeyboard = new InlineKeyboard()
				.text('📊 Все сообщения', callbackAll)
				.row()
				.text('500', callback500)
				.text('1000', callback1000)
				.row()
				.text('2000', callback2000)
				.text('5000', callback5000)
				.row()
				.text('10000', callback10000)
				.row()
				.text('✏️ Ввести число', callbackCustom);

			console.log('📤 Отправляю сообщение с клавиатурой выбора...');

			await ctx.reply(
				`📊 Готов к анализу!\n` +
					`📁 Обработано файлов: ${totalFilesProcessed}\n` +
					`📨 Всего сообщений: ${allMessages.length}\n\n` +
					`Выберите, сколько сообщений анализировать:`,
				{
					reply_markup: limitKeyboard,
				}
			);

			// Сохраняем общий массив для этого чата
			pendingMessages.set(chatId, {
				messages: allMessages,
				fileName: `все_файлы_(${totalFilesProcessed})`,
			});

			for (const [index, msg] of allMessages.entries()) {
				try {
					const text = msg.text.toLowerCase();
					let violation: string | null = null;

					// Анализ нейросетью с возможностью прерывания
					if (USE_NEURAL_NETWORK && text.length > 3) {
						if (index === 0 || index % 100 === 0) {
							console.log(
								`🧠 [${index + 1}/${
									allMessages.length
								}] Вызываю нейросеть для анализа: "${text.substring(0, 50)}..."`
							);
						}
						try {
							const neuralViolation = await analyzeSequentially(text);

							if (neuralViolation && typeof neuralViolation === 'object') {
								console.log(
									`🚨 [${index + 1}] Нейросеть обнаружила нарушение: ${
										neuralViolation.topic
									}`
								);
								violation = `neural_${neuralViolation.topic}`;
							} else if (index === 0 || index % 100 === 0) {
								console.log(
									`✅ [${index + 1}] Нейросеть не обнаружила нарушений`
								);
							}
						} catch (error: any) {
							console.error('❌ Ошибка в startAnalysisFromAllMessages:', error);
							await ctx.reply('❌ Ошибка при запуске анализа');
						}
					}
				} catch (error: any) {
					console.error('❌ Ошибка в startAnalysisFromAllMessages:', error);
					await ctx.reply('❌ Ошибка при запуске анализа');
				}
			}
		} catch (error: any) {
			console.error('❌ Ошибка в startAnalysisFromAllMessages:', error);
			await ctx.reply('❌ Ошибка при запуске анализа');
		}
	}

	bot.command('analyze', async ctx => {
		await startAnalysisFromAllMessages(ctx);
	});
	// Map для хранения ожидающих ввода числа сообщений
	const waitingForCustomLimit = new Map<number, boolean>();

	bot.on('callback_query:data', async ctx => {
		const data = ctx.callbackQuery?.data;
		console.log(`🔔 [bot.ts] Получен callback_query: ${data}`);
		if (!data) {
			console.log('⚠️ [bot.ts] Callback data пустой');
			return;
		}

		if (data.startsWith('cancel_')) {
			const chatId = Number(data.split('_')[1]);
			const analysis = activeAnalyses.get(chatId);

			if (analysis && !analysis.cancel) {
				analysis.cancel = true;
				analysis.controller?.abort(); // 👈 реально прерывает axios.post
				await ctx.answerCallbackQuery({ text: '⏹ Анализ остановлен.' });
				// Сообщение об отмене будет обновлено в функции startAnalysis
				// Не удаляем анализ здесь - функция startAnalysis сама удалит его после обработки
			} else {
				await ctx.answerCallbackQuery({
					text: '⚠️ Анализ не выполняется.',
					show_alert: false,
				});
			}
			return;
		}

		if (data.startsWith('analyze_limit_')) {
			console.log(`🔔 [bot.ts] Обработка callback: ${data}`);
			// Формат: analyze_limit_<chatId>_<limit>
			const match = data.match(/^analyze_limit_(\d+)_(.+)$/);
			if (!match) {
				console.log(`❌ [bot.ts] Неверный формат callback_data: ${data}`);
				await ctx.answerCallbackQuery({
					text: '❌ Ошибка формата callback',
					show_alert: true,
				});
				return;
			}
			const chatId = Number(match[1]);
			const limitStr = match[2];
			console.log(
				`📌 [bot.ts] Chat ID из callback: ${chatId}, limit: ${limitStr}`
			);

			const pending = pendingMessages.get(chatId);
			if (!pending) {
				console.log(`❌ Данные о файле не найдены для чата ${chatId}`);
				await ctx.answerCallbackQuery({
					text: '⚠️ Данные о файле не найдены. Загрузите файл заново.',
					show_alert: true,
				});
				return;
			}

			console.log(
				`✅ Найдены данные: ${pending.messages.length} сообщений, файл: ${pending.fileName}`
			);
			await ctx.answerCallbackQuery();

			if (limitStr === 'custom') {
				console.log('✏️ Пользователь выбрал ввод произвольного числа');
				waitingForCustomLimit.set(chatId, true);
				await ctx.editMessageText(
					`✏️ Введите количество сообщений для анализа (от 1 до ${pending.messages.length}):`
				);
				return;
			}

			let limit: number | null = null;
			if (limitStr !== 'all') {
				limit = Number.parseInt(limitStr, 10);
				if (isNaN(limit) || limit < 1) {
					console.log(`❌ Некорректное количество: ${limitStr}`);
					await ctx.reply('❌ Некорректное количество сообщений.');
					return;
				}
				if (limit > pending.messages.length) {
					limit = pending.messages.length;
				}
			}
			console.log(
				`🚀 Запускаю анализ с лимитом: ${limit === null ? 'все' : limit}`
			);

			pendingMessages.delete(chatId);
			await ctx.editMessageText('✅ Начинаю анализ...');
			await startAnalysis(
				ctx,
				chatId,
				pending.messages,
				pending.fileName,
				limit
			);
		}
	});

	bot.on('message', async ctx => {
		const chatId = ctx.chat.id;
		const msgText = ctx.message.text ?? ctx.message.caption ?? '';

		if (ctx.message.document) {
			// Если ожидается ввод числа, но пришел документ - сбрасываем ожидание
			if (waitingForCustomLimit.has(chatId)) {
				waitingForCustomLimit.delete(chatId);
				pendingMessages.delete(chatId);
			}
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

		// Обработка ввода произвольного количества сообщений
		if (waitingForCustomLimit.has(chatId)) {
			const pending = pendingMessages.get(chatId);
			if (!pending) {
				waitingForCustomLimit.delete(chatId);
				return;
			}

			const limitStr = msgText.trim();
			const limit = Number.parseInt(limitStr, 10);

			if (isNaN(limit) || limit < 1) {
				await ctx.reply(
					`❌ Некорректное число. Введите число от 1 до ${pending.messages.length}:`
				);
				return;
			}

			const actualLimit = Math.min(limit, pending.messages.length);
			waitingForCustomLimit.delete(chatId);
			pendingMessages.delete(chatId);

			await ctx.reply(`✅ Анализирую ${actualLimit} сообщений...`);
			await startAnalysis(
				ctx,
				chatId,
				pending.messages,
				pending.fileName,
				actualLimit
			);
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
