async function getAssistantResponse(taskType, userPrompt) {
    const systemInstruction = await loadPromptFromSupabase(taskType); // Завантаження з вашої БД Supabase
    // Виклик OpenAI з цією інструкцією
}
