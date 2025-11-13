import axios from 'axios';
import { getCurrentModel } from './state';

const NEURAL_API_URL = 'http://10.8.0.24:11434/v1/chat/completions';

export const AVAILABLE_MODELS = [
	'qwen2.5-coder:7b',
	'qwen3:30b',
	'hf.co/bartowski/Qwen_Qwen3-30B-A3B-Thinking-2507-GGUF:Q4_K_M',
	'hf.co/unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF:Q4_K_M',
];

// Упрощенные типы или используем any для избежания ошибок
interface NeuralApiResponse {
	choices?: Array<{
		message?: {
			content?: string;
		};
		finish_reason?: string;
	}>;
}

// Настройки тематик
export interface TopicConfig {
	name: string;
	systemPrompt: string;
	keywords: string[];
	priority: number;
	enabled: boolean;
}

// Конфигурация тематик
export const TOPICS: TopicConfig[] = [];

// Результат анализа
export interface NeuralResult {
	topic: string;
	detected: boolean;
	confidence?: number;
	reason?: string;
}

// Основная функция анализа
export async function analyzeWithNeural(
	message: string,
	topicName: string,
	signal?: AbortSignal
): Promise<NeuralResult> {
	try {
		const topic = TOPICS.find(t => t.name === topicName);
		if (!topic || !topic.enabled) {
			return { topic: topicName, detected: false };
		}
		const currentModel = getCurrentModel();
		console.log(
			`🧠 Запуск нейросети для темы "${topicName}":`,
			message.substring(0, 100)
		);

		// Используем any для response data чтобы избежать проблем с типами
		const response = await axios.post(
			NEURAL_API_URL,
			{
				model: currentModel,
				messages: [
					{ role: 'system', content: topic.systemPrompt },
					{ role: 'user', content: `Сообщение для анализа: "${message}"` },
				],
				temperature: 0.1,
				max_tokens: 50,
			},
			{
				timeout: 15000,
				headers: { 'Content-Type': 'application/json' },
				...(signal ? { signal } : {}), // ✅ безопасно добавляем, если есть
			} as any // ✅ подавляем TS-ошибку
		);

		// Безопасное извлечение данных с проверками
		const data = response.data as any;

		console.log('🧠 Полный ответ нейросети:', JSON.stringify(data, null, 2));

		// Проверяем разные возможные структуры ответа
		let content: string | undefined;

		if (data.choices && Array.isArray(data.choices) && data.choices[0]) {
			// Стандартная структура OpenAI
			content = data.choices[0]?.message?.content;
		} else if (data.response) {
			// Альтернативная структура
			content = data.response;
		} else if (data.content) {
			// Другая возможная структура
			content = data.content;
		} else {
			console.warn('Неизвестная структура ответа нейросети:', data);
			return { topic: topicName, detected: false };
		}

		if (!content) {
			console.warn('Нейросеть вернула пустой ответ');
			return { topic: topicName, detected: false };
		}

		const answer = content.trim().toUpperCase();
		const detected = answer.includes('ДА');

		console.log(`🧠 Результат нейросети [${topicName}]:`, {
			answer: content,
			detected,
			finish_reason: data.choices?.[0]?.finish_reason,
		});

		return {
			topic: topicName,
			detected,
			reason: content,
		};
	} catch (error: any) {
		console.error(`Ошибка нейросети (${topicName}):`, error.message);

		if (error.response) {
			console.error('Детали ошибки:', error.response.data);
		}

		return {
			topic: topicName,
			detected: false,
			reason: 'API Error: ' + error.message,
		};
	}
}

export async function analyzeSequentially(
	message: string,
	signal?: AbortSignal
): Promise<NeuralResult | null> {
	// Сортируем темы по приоритету (от высшего к низшему)
	const sortedTopics = [...TOPICS]
		.filter(topic => topic.enabled)
		.sort((a, b) => a.priority - b.priority);

	for (const topic of sortedTopics) {
		if (signal?.aborted) throw new Error('cancelled'); // 👈 проверка отмены
		const result = await analyzeWithNeural(message, topic.name, signal);

		if (result.detected) {
			console.log(
				`🚨 Обнаружено нарушение в теме ${topic.name}, остальные проверки пропускаются`
			);
			return result;
		}
	}

	return null; // Нарушений не обнаружено
}

// Массовый анализ по всем темам
export async function analyzeAllTopics(
	message: string
): Promise<NeuralResult[]> {
	const promises = TOPICS.filter(topic => topic.enabled).map(topic =>
		analyzeWithNeural(message, topic.name)
	);

	return Promise.all(promises);
}

// Получить активные темы
export function getActiveTopics(): TopicConfig[] {
	return TOPICS.filter(topic => topic.enabled);
}

// Включить/выключить тему
import { dbPromise } from './db.js';

export async function toggleTopic(
	topicName: string,
	enabled: boolean
): Promise<boolean> {
	const topic = TOPICS.find(t => t.name === topicName);
	if (!topic) return false;

	topic.enabled = enabled;

	try {
		const db = await dbPromise;
		await db.run(`UPDATE topics SET enabled = ? WHERE name = ?`, [
			enabled ? 1 : 0,
			topicName,
		]);
		console.log(
			`🧠 Тематика "${topicName}" теперь ${enabled ? 'включена' : 'выключена'}`
		);
		return true;
	} catch (err) {
		console.error('Ошибка при обновлении темы в БД:', err);
		return false;
	}
}

export function getTopicsByPriority(): TopicConfig[] {
	return [...TOPICS].sort((a, b) => a.priority - b.priority);
}
