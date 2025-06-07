// api/generate-astral-chart.js

// Importa la librería de Google Generative AI para interactuar con Gemini.
const { GoogleGenerativeLanguageServiceClient } = require('@google/generative-ai');

// Configura el cliente para la API de Gemini (para la generación de texto).
const genAI = new GoogleGenerativeLanguageServiceClient({
    auth: {
        // La clave API de Gemini se obtiene de las variables de entorno de Vercel de forma segura.
        apiKey: process.env.GEMINI_API_KEY, 
    },
});

// Define el modelo de lenguaje de Google Gemini a utilizar.
const TEXT_MODEL_NAME = "gemini-2.0-flash";

/**
 * Función principal sin servidor que maneja las solicitudes del frontend para generar la carta astral.
 * Orquesta las llamadas a APIs de geocodificación, zona horaria y cálculo astrológico,
 * y luego utiliza Gemini para interpretar los datos precisos.
 * * @param {object} req - Objeto de solicitud HTTP (contiene el cuerpo con los datos del usuario).
 * @param {object} res - Objeto de respuesta HTTP (para enviar la carta astral generada al frontend).
 */
module.exports = async (req, res) => {
    console.log("Función sin servidor 'generate-astral-chart' llamada.");

    // Configura los encabezados CORS (Cross-Origin Resource Sharing)
    // Esto es crucial para permitir que tu frontend (probablemente en GitHub Pages)
    // pueda comunicarse con esta función sin servidor (en Vercel).
    res.setHeader('Access-Control-Allow-Origin', 'https://pablopavlov.github.io'); // Permite solicitudes desde tu dominio de GitHub Pages
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS'); // Define los métodos HTTP permitidos
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); // Define los encabezados HTTP permitidos en la solicitud

    // Maneja las solicitudes OPTIONS (preflight requests de CORS).
    // El navegador envía una solicitud OPTIONS antes de la solicitud POST real para verificar los permisos CORS.
    if (req.method === 'OPTIONS') {
        console.log("Solicitud OPTIONS (CORS preflight) recibida. Respondiendo 200 OK.");
        return res.status(200).end(); // Termina la respuesta OPTIONS
    }

    // Asegúrate de que la solicitud entrante sea un método POST.
    if (req.method !== 'POST') {
        console.log(`Método no permitido: ${req.method}. Solo se aceptan solicitudes POST.`);
        return res.status(405).json({ message: 'Método no permitido. Solo se aceptan solicitudes POST.' });
    }

    // Verifica que todas las claves API necesarias estén configuradas como variables de entorno en Vercel.
    if (!process.env.GEMINI_API_KEY) {
        console.error('Error: GEMINI_API_KEY no configurada en las variables de entorno de Vercel.');
        return res.status(500).json({ message: 'Error interno del servidor: Clave API GEMINI_API_KEY no configurada.' });
    }
    if (!process.env.TIMEZONEDB_API_KEY) {
        console.error('Error: TIMEZONEDB_API_KEY no configurada en las variables de entorno de Vercel.');
        return res.status(500).json({ message: 'Error interno del servidor: Clave API TIMEZONEDB_API_KEY no configurada.' });
    }
    if (!process.env.ASTRO_API_KEY) { // ¡REEMPLAZAR con el nombre de tu variable de entorno para la API de cálculo astrológico!
        console.error('Error: ASTRO_API_KEY no configurada en las variables de entorno de Vercel.');
        return res.status(500).json({ message: 'Error interno del servidor: Clave API ASTRO_API_KEY no configurada.' });
    }

    try {
        const { birthDate, birthTime, birthPlace, userSex, language } = req.body;

        // Valida que todos los datos esenciales estén presentes en la solicitud.
        if (!birthDate || !birthTime || !birthPlace || !userSex || !language) {
            console.log("Datos de entrada faltantes en la solicitud:", req.body);
            return res.status(400).json({ message: 'Datos de nacimiento o sexo incompletos. Se requieren fecha, hora, lugar y sexo del usuario.' });
        }

        let latitude, longitude;
        let timezoneId, rawOffsetSeconds, dstOffsetSeconds;
        let finalAstroData = {}; // Objeto para almacenar los datos astrológicos precisos.

        // --- 1. LLAMADA A LA API DE GEOCODIFICACIÓN (OpenStreetMap Nominatim) ---
        console.log(`Intentando geocodificar lugar con Nominatim: ${birthPlace}`);
        const nominatimUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(birthPlace)}&limit=1`;
        try {
            // Es CRÍTICO incluir un User-Agent significativo para Nominatim, de lo contrario, puede bloquearte.
            const nominatimResponse = await fetch(nominatimUrl, {
                headers: {
                    'User-Agent': 'CartaAstralApp/1.0 (ppastorguerra@gmail.com)' 
                }
            });
            if (!nominatimResponse.ok) {
                throw new Error(`Error HTTP de Nominatim: ${nominatimResponse.status} - ${nominatimResponse.statusText}`);
            }
            const nominatimData = await nominatimResponse.json();

            if (nominatimData && nominatimData.length > 0) {
                latitude = parseFloat(nominatimData[0].lat);
                longitude = parseFloat(nominatimData[0].lon);
                console.log(`Geocodificación exitosa: Lat ${latitude}, Lng ${longitude}`);
            } else {
                console.error(`ERROR: No se encontraron resultados para el lugar: ${birthPlace}.`);
                return res.status(404).json({ message: 'No se pudo encontrar las coordenadas para el lugar de nacimiento proporcionado. Intenta con una ubicación más específica.' });
            }
        } catch (error) {
            console.error(`Error al geocodificar con Nominatim para ${birthPlace}:`, error.message);
            return res.status(500).json({ message: `Error al conectar con el servicio de geocodificación. Detalles: ${error.message}` });
        }

        // --- 2. LLAMADA A LA API DE ZONA HORARIA (TimezoneDB) ---
        console.log(`Intentando obtener zona horaria con TimezoneDB para Lat ${latitude}, Lng ${longitude}`);
        const timezoneDbApiKey = process.env.TIMEZONEDB_API_KEY;
        // Convierte la fecha y hora de nacimiento a un timestamp Unix en segundos UTC.
        // Se asume que birthTime es en formato "HH:MM".
        const localDateTimeString = `${birthDate}T${birthTime}:00`; // Asegura formato ISO para Date
        const localDate = new Date(localDateTimeString);

        if (isNaN(localDate.getTime())) {
            console.error(`Error de parseo de fecha/hora: ${birthDate}T${birthTime}`);
            return res.status(400).json({ message: 'Formato de fecha u hora de nacimiento inválido.' });
        }

        const timestamp = Math.floor(localDate.getTime() / 1000); // Unix timestamp en segundos

        const timezoneDbUrl = `http://api.timezonedb.com/v2.1/get-time-zone?key=${timezoneDbApiKey}&format=json&by=position&lat=${latitude}&lng=${longitude}&time=${timestamp}`;
        try {
            const timezoneResponse = await fetch(timezoneDbUrl);
            if (!timezoneResponse.ok) {
                throw new Error(`Error HTTP de TimezoneDB: ${timezoneResponse.status} - ${timezoneResponse.statusText}`);
            }
            const timezoneData = await timezoneResponse.json();

            if (timezoneData.status === 'OK') {
                timezoneId = timezoneData.zoneName; // Ej: America/Caracas
                rawOffsetSeconds = timezoneData.gmtOffset; // Offset GMT en segundos (ya incluye DST si aplica para el timestamp)
                dstOffsetSeconds = timezoneData.dst; // 0 si no hay DST, o la duración del DST en segundos
                console.log(`Zona horaria exitosa: ${timezoneId}, GMT Offset: ${rawOffsetSeconds / 3600} horas, DST: ${dstOffsetSeconds / 3600} horas`);
            } else {
                console.error(`ERROR: No se pudo obtener la zona horaria para Lat ${latitude}, Lng ${longitude}. Error: ${timezoneData.message}`);
                return res.status(404).json({ message: `No se pudo determinar la zona horaria precisa para el lugar y la fecha proporcionados. ${timezoneData.message}` });
            }
        } catch (error) {
            console.error(`Error al obtener zona horaria con TimezoneDB para ${latitude}, ${longitude}:`, error.message);
            return res.status(500).json({ message: `Error al conectar con el servicio de zona horaria. Detalles: ${error.message}` });
        }

        // --- 3. LLAMADA A LA API DE CÁLCULO ASTROLÓGICO (Ejemplo: Astro-API.com) ---
        console.log("Intentando obtener cálculos astrológicos con Astro-API.com...");
        const astroApiKey = process.env.ASTRO_API_KEY; // Tu clave API para Astro-API.com
        const astroApiUrl = 'https://api.astro-api.com/v1/chart'; // Endpoint de Astro-API.com

        // Los datos para la solicitud de la API astrológica
        const astroApiRequestBody = {
            datetime: {
                year: parseInt(birthDate.substring(0, 4)),
                month: parseInt(birthDate.substring(5, 7)),
                day: parseInt(birthDate.substring(8, 10)),
                hour: parseInt(birthTime.substring(0, 2)),
                minute: parseInt(birthTime.substring(3, 5)),
                second: 0, // Generalmente no se especifica
                zone: rawOffsetSeconds / 3600 // Offset GMT en horas (ej. -5 para Caracas)
            },
            location: {
                latitude: latitude,
                longitude: longitude
            },
            settings: {
                // Puedes ajustar estos si tu API lo permite y tu necesitas algo específico.
                // Consulta la documentación de tu API de cálculo astrológico.
                tropical: true, // Verdadero para astrología occidental (Zodiaco Tropical)
                aspects: {
                    conjunction: true, opposition: true, trine: true, square: true, sextile: true, // Aspectos principales
                    // Puedes añadir más aspectos si tu API los soporta y Gemini los puede interpretar bien
                    // quincunx: true, semisextile: true, quintile: true, biquintile: true, etc.
                },
                orb: {
                    // Puedes ajustar los orbes si tu API lo permite.
                    // Estos son orbes comunes.
                    conjunction: 8, opposition: 8, trine: 8, square: 8, sextile: 6,
                },
                house_system: "placidus" // Sistema de casas común, puedes cambiarlo si prefieres otro (koch, whole_signs, etc.)
            }
        };

        try {
            const astroApiResponse = await fetch(astroApiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${astroApiKey}` // Astro-API.com usa Bearer Token
                    // Algunas APIs pueden requerir 'x-api-key' en lugar de 'Authorization'
                },
                body: JSON.stringify(astroApiRequestBody)
            });

            if (!astroApiResponse.ok) {
                const errorBody = await astroApiResponse.text(); // Lee el cuerpo del error para más detalles
                throw new Error(`Error HTTP de Astro-API.com: ${astroApiResponse.status} - ${astroApiResponse.statusText}. Detalles: ${errorBody}`);
            }

            const astroCalcRawData = await astroApiResponse.json();
            console.log("Datos astrológicos obtenidos de Astro-API.com:", JSON.stringify(astroCalcRawData, null, 2).substring(0, 500) + "..."); // Log de los datos (truncado)

            // --- Mapear la respuesta de la API de cálculo astrológico a un formato para Gemini ---
            // Esto es crucial y DEBE coincidir con la estructura REAL de la respuesta de la API que uses.
            // El siguiente es un ejemplo basado en una estructura común de Astro-API.com.
            
            const planetsData = Object.keys(astroCalcRawData.data.planets).map(key => {
                const planet = astroCalcRawData.data.planets[key];
                return `${key} en ${planet.sign.name} a ${planet.degree}° en Casa ${planet.house}`;
            }).join(', ');

            const housesData = Object.keys(astroCalcRawData.data.houses).map(key => {
                const house = astroCalcRawData.data.houses[key];
                return `Casa ${house.number} en ${house.sign.name} a ${house.degree}°`;
            }).join(', ');

            const aspectsData = astroCalcRawData.data.aspects.all.map(aspect => {
                const p1 = aspect.body1.name_en; // Nombre del planeta 1
                const p2 = aspect.body2.name_en; // Nombre del planeta 2
                const type = aspect.aspect.name_en; // Tipo de aspecto (ej. "Conjunction")
                const orb = aspect.orb; // Orbe del aspecto
                return `${p1} en ${type} con ${p2} (orbe ${orb}°)`;
            }).join(', ');

            finalAstroData = {
                birthDate: birthDate,
                birthTime: birthTime,
                birthPlace: birthPlace,
                userSex: userSex,
                timezoneId: timezoneId,
                rawOffsetHours: rawOffsetSeconds / 3600,
                latitude: latitude,
                longitude: longitude,
                // Datos precisos de la API de cálculo
                sunSign: astroCalcRawData.data.planets.sun.sign.name,
                moonSign: astroCalcRawData.data.planets.moon.sign.name,
                ascendant: astroCalcRawData.data.houses.house1.sign.name,
                planetsPositions: planetsData, // Todas las posiciones de planetas mapeadas
                housesCusps: housesData,      // Todas las cúspides de casas mapeadas
                keyAspects: aspectsData       // Todos los aspectos mapeados
            };

            console.log("Datos astrológicos finales para Gemini:", JSON.stringify(finalAstroData, null, 2).substring(0, 500) + "...");

        } catch (error) {
            console.error("Error al llamar a la API de cálculo astrológico (Astro-API.com):", error.message);
            return res.status(500).json({ message: `Error al obtener los cálculos astrológicos precisos. Detalles: ${error.message}` });
        }


        // --- 4. CONSTRUIR PROMPT PARA GEMINI CON DATOS PRECISOS ---
        // El prompt ahora utiliza 'finalAstroData' con los datos REALES obtenidos de las APIs.
        const textPrompt = `Genera una interpretación completa de la carta astral basada en los siguientes datos de nacimiento:
        Fecha de Nacimiento: ${finalAstroData.birthDate}
        Hora de Nacimiento: ${finalAstroData.birthTime}
        Lugar de Nacimiento: ${finalAstroData.birthPlace}
        Sexo del Usuario: ${finalAstroData.userSex}
        Latitud: ${finalAstroData.latitude}
        Longitud: ${finalAstroData.longitude}
        Zona Horaria Identificada: ${finalAstroData.timezoneId} (Offset GMT: ${finalAstroData.rawOffsetHours} horas)

        Y los siguientes datos astrológicos precisos calculados:
        Signo Solar: ${finalAstroData.sunSign}
        Signo Lunar: ${finalAstroData.moonSign}
        Ascendente: ${finalAstroData.ascendant}
        Posiciones de Planetas: ${finalAstroData.planetsPositions}
        Cúspides de Casas: ${finalAstroData.housesCusps}
        Aspectos Clave: ${finalAstroData.keyAspects}

        La interpretación debe ser altamente profesional, profunda, narrativa y psicológicamente atractiva. Utiliza principios de Neuro-Linguistic Programming (PNL) para inspirar, captar la atención y motivar el crecimiento personal, fomentando una sensación agradable, mental y psicológicamente enriquecedora para el lector. El tono debe ser directo ("tú"). La interpretación debe ser sensible al género del usuario.

        La interpretación debe estructurarse con las siguientes 28 secciones exactas y en este orden. ¡No incluyas ninguna sección o mención a Eneagrama, Chakras, pareja ideal o imágenes!

        1.  Los Componentes Fundamentales de tu Carta Astral
        2.  La Interpretación de tu Carta Astral: Un Viaje Personal
        3.  Beneficios de Conocer tu Carta Astral: Tu Poder Interior
        4.  Análisis Completo, Profundo y Detallado de tu Mapa Cósmico
        5.  Síntesis General de tu Perfil Astrológico: Tu Esencia Única
        6.  La Dinámica de la Armonía: Integrando tus Luces
        7.  Un Enfoque Positivo para la Pasión y la Vida: Tu Energía Radiante
        8.  La Sexualidad: Un Viaje de Conexión Profunda y Placer
        9.  La Relación Contigo Mismo
        10. El Aspecto Social: Tu Brillo en la Conexión Humana
        11. El Aspecto Laboral: Tu Propósito en Acción
        12. El Aspecto Artístico: La Danza de tu Creatividad
        13. El Ego: Tu Guardián y Maestro Interior
        14. El Verdadero Yo: La Voz de tu Alma
        15. Sanar la Herida (Quirón): Abrazando tu Poder de Transformación
        16. El Viaje del Alma: Tu Sendero Evolutivo
        17. El Viaje del Alma por Edad y Años en el Mundo: Tu Crecimiento Constante
        18. El Propósito de Vida y del Mundo: Tu Huella Cósmica
        19. El Amor en la Carta Astral: Un Universo de Conexiones
        20. La Salud: Tu Templo Sagrado y Vibrante
        21. El Aspecto Deportivo y el Ejercicio: La Alegría del Movimiento
        22. El Dinero, Finanzas y Emprendimiento: Fluyendo con la Abundancia
        23. Espiritualidad y Conexión Divina: Tu Puente con lo Infinito
        24. Proyección Futura y Conexión Angelical: Tu Destino Luminoso
        25. Lujos Materiales, Turismo, Hogar y Estilo Personal: Celebrando la Vida
        26. Vidas Pasadas: Los Ecos de tu Sabiduría Ancestral
        27. Técnicas para Sanar la Herida: Herramientas para tu Florecimiento
        28. Trascender la Furia del Ego a la Paz del Amor: Un Camino de Maestría

        Proporciona herramientas y técnicas prácticas para las secciones 27 y 28.
        Responde enteramente en ${language === 'es' ? 'Spanish' : 'English'}. El formato final debe ser Markdown.`;

        console.log("Prompt enviado a Gemini (primeros 500 caracteres):", textPrompt.substring(0, 500) + "...");

        // Realiza la llamada a la API de Gemini para obtener la interpretación textual.
        const model = genAI.getGenerativeModel({ model: TEXT_MODEL_NAME });
        const result = await model.generateContent({ contents: [{ role: "user", parts: [{ text: textPrompt }] }] });

        // Extrae el texto de la respuesta de Gemini.
        const chartText = result.response.candidates[0].content.parts[0].text;
        console.log("Respuesta de Gemini recibida y procesada. Tamaño del texto:", chartText.length);

        // Envía la carta astral generada de vuelta al frontend.
        res.status(200).json({ chartText });

    } catch (error) {
        // Manejo de errores centralizado: Si ocurre algún error en cualquier etapa, se registra y se notifica al frontend.
        console.error('Error general en la función sin servidor:', error);
        res.status(500).json({ message: `Error interno del servidor al procesar la solicitud de la carta astral. Por favor, inténtalo de nuevo más tarde o contacta al soporte. Detalles técnicos: ${error.message}` });
    }
};


