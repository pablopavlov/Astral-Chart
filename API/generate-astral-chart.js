// api/generate-astral-chart.js

// Importa la librería de Google Generative AI para interactuar con Gemini.
const { GoogleGenerativeLanguageServiceClient } = require('@google/generative-ai');
// Importa la librería 'astrology' para realizar cálculos astrológicos directamente.
const Astrology = require('astrology');

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
 * Orquesta las llamadas a APIs de geocodificación, zona horaria y realiza cálculos astrológicos con una librería,
 * y luego utiliza Gemini para interpretar los datos precisos.
 * * @param {object} req - Objeto de solicitud HTTP (contiene el cuerpo con los datos del usuario).
 * @param {object} res - Objeto de respuesta HTTP (para enviar la carta astral generada al frontend).
 */
module.exports = async (req, res) => {
    console.log("Función sin servidor 'generate-astral-chart' llamada.");

    // Configura los encabezados CORS (Cross-Origin Resource Sharing)
    res.setHeader('Access-Control-Allow-Origin', 'https://pablopavlov.github.io'); // Permite solicitudes desde tu dominio de GitHub Pages
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS'); // Define los métodos HTTP permitidos
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); // Define los encabezados HTTP permitidos en la solicitud

    // Maneja las solicitudes OPTIONS (preflight requests de CORS).
    if (req.method === 'OPTIONS') {
        console.log("Solicitud OPTIONS (CORS preflight) recibida. Respondiendo 200 OK.");
        return res.status(200).end(); // Termina la respuesta OPTIONS
    }

    // Asegúrate de que la solicitud entrante sea un método POST.
    if (req.method !== 'POST') {
        console.log(`Método no permitido: ${req.method}. Solo se aceptan solicitudes POST.`);
        return res.status(405).json({ message: 'Método no permitido. Solo se aceptan solicitudes POST.' });
    }

    // Verifica que las claves API necesarias estén configuradas como variables de entorno en Vercel.
    if (!process.env.GEMINI_API_KEY) {
        console.error('Error: GEMINI_API_KEY no configurada en las variables de entorno de Vercel.');
        return res.status(500).json({ message: 'Error interno del servidor: Clave API GEMINI_API_KEY no configurada.' });
    }
    if (!process.env.GOOGLE_MAPS_API_KEY) { 
        console.error('Error: GOOGLE_MAPS_API_KEY no configurada en las variables de entorno de Vercel.');
        return res.status(500).json({ message: 'Error interno del servidor: Clave API GOOGLE_MAPS_API_KEY no configurada.' });
    }

    try {
        const { birthDate, birthTime, birthPlace, userSex, language } = req.body;

        // Valida que todos los datos esenciales estén presentes en la solicitud.
        if (!birthDate || !birthTime || !birthPlace || !userSex || !language) {
            console.log("Datos de entrada faltantes en la solicitud:", req.body);
            return res.status(400).json({ message: 'Datos de nacimiento o sexo incompletos. Se requieren fecha, hora, lugar y sexo del usuario.' });
        }

        let latitude, longitude;
        let timezoneId, rawOffsetSeconds; // Eliminamos dstOffsetSeconds ya que Google Time Zone API consolida en rawOffset
        let finalAstroData = {}; // Objeto para almacenar los datos astrológicos precisos.

        // --- 1. LLAMADA A LA API DE GEOCODIFICACIÓN (OpenStreetMap Nominatim) ---
        console.log(`Intentando geocodificar lugar con Nominatim: ${birthPlace}`);
        const nominatimUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(birthPlace)}&limit=1`;
        try {
            const nominatimResponse = await fetch(nominatimUrl, {
                headers: {
                    // Es CRÍTICO incluir un User-Agent significativo para Nominatim, de lo contrario, puede bloquearte.
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

        // --- 2. LLAMADA A LA API DE ZONA HORARIA (Google Maps Time Zone API) ---
        console.log(`Intentando obtener zona horaria con Google Maps Time Zone API para Lat ${latitude}, Lng ${longitude}`);
        const googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY; // Usa la nueva clave de Google Maps Platform

        const localDateTimeString = `${birthDate}T${birthTime}:00`; // Asegura formato ISO para Date
        const localDate = new Date(localDateTimeString);

        if (isNaN(localDate.getTime())) {
            console.error(`Error de parseo de fecha/hora: ${birthDate}T${birthTime}`);
            return res.status(400).json({ message: 'Formato de fecha u hora de nacimiento inválido.' });
        }
        const timestamp = Math.floor(localDate.getTime() / 1000); // Unix timestamp en segundos

        const googleTimeZoneUrl = `https://maps.googleapis.com/maps/api/timezone/json?location=${latitude},${longitude}&timestamp=${timestamp}&key=${googleMapsApiKey}`;
        try {
            const timezoneResponse = await fetch(googleTimeZoneUrl);
            if (!timezoneResponse.ok) {
                throw new Error(`Error HTTP de Google Time Zone API: ${timezoneResponse.status} - ${timezoneResponse.statusText}`);
            }
            const timezoneData = await timezoneResponse.json();

            if (timezoneData.status === 'OK') {
                timezoneId = timezoneData.timeZoneId; // Ej: America/Caracas
                // Google Time Zone API devuelve el offset total (rawOffset + dstOffset) en segundos en 'dstOffset' si hay DST,
                // o solo rawOffset si no hay DST. Para cálculos astrológicos, el offset total es lo que importa.
                rawOffsetSeconds = timezoneData.dstOffset + timezoneData.rawOffset; 
                console.log(`Zona horaria exitosa (Google Maps): ${timezoneId}, Offset Total: ${rawOffsetSeconds / 3600} horas`);
            } else {
                console.error(`ERROR: No se pudo obtener la zona horaria para Lat ${latitude}, Lng ${longitude}. Error: ${timezoneData.errorMessage || 'Desconocido'}`);
                return res.status(404).json({ message: `No se pudo determinar la zona horaria precisa para el lugar y la fecha proporcionados. ${timezoneData.errorMessage || ''}` });
            }
        } catch (error) {
            console.error(`Error al obtener zona horaria con Google Maps Time Zone API para ${latitude}, ${longitude}:`, error.message);
            return res.status(500).json({ message: `Error al conectar con el servicio de zona horaria de Google. Detalles: ${error.message}` });
        }

        // --- 3. CÁLCULO ASTROLÓGICO (Utilizando la librería 'astrology') ---
        console.log("Realizando cálculos astrológicos con la librería 'astrology'...");
        
        // Ajusta la fecha y hora a UTC utilizando el offset de la zona horaria obtenida.
        // La librería 'astrology' espera la hora de nacimiento en UTC para los cálculos.
        const birthDateTimeUTC = new Date(localDate.getTime() - rawOffsetSeconds * 1000);

        const year = birthDateTimeUTC.getFullYear();
        const month = birthDateTimeUTC.getMonth() + 1; // getMonth() es 0-11
        const day = birthDateTimeUTC.getDate();
        const hour = birthDateTimeUTC.getHours();
        const minute = birthDateTimeUTC.getMinutes();
        const second = birthDateTimeUTC.getSeconds();

        // Configuración para la librería 'astrology'
        const astrology = new Astrology({
            // Puedes ajustar el sistema de casas si lo deseas. Placidus es común.
            // Más info en la documentación de la librería 'astrology'.
            houseSystem: "placidus" 
        });

        // Realiza los cálculos de la carta natal
        const chart = astrology.getChart({
            year,
            month,
            day,
            hour,
            minute,
            second,
            latitude,
            longitude
        });

        console.log("Cálculos astrológicos con 'astrology' completados.");
        // console.log("Resultado del cálculo:", JSON.stringify(chart, null, 2)); // Para depuración

        // --- Mapear la respuesta de la librería 'astrology' a un formato para Gemini ---
        // Extraemos los datos relevantes de la estructura de 'chart' para el prompt de Gemini.
        const planetsData = Object.keys(chart.planets).map(key => {
            const planet = chart.planets[key];
            // Asegurarse de que el signo y el grado existan.
            const signName = planet.sign ? planet.sign.name : 'Desconocido';
            const degree = planet.position ? planet.position.toFixed(2) : '0.00';
            const houseNumber = planet.house ? planet.house.toFixed(0) : 'N/A'; // Número de casa como entero
            return `${planet.name} en ${signName} a ${degree}° en Casa ${houseNumber}`;
        }).join(', ');

        const housesData = Object.keys(chart.houses).map(key => {
            const house = chart.houses[key];
            const signName = house.sign ? house.sign.name : 'Desconocido';
            const degree = house.position ? house.position.toFixed(2) : '0.00';
            return `Casa ${house.name} en ${signName} a ${degree}°`; // 'house.name' es el número de casa (1-12)
        }).join(', ');
        
        // La librería 'astrology' no calcula aspectos tan detalladamente por defecto en su objeto principal
        // Sin embargo, podemos inferirlos o generar una lista simple si la librería lo permite de otra forma.
        // Para simplificar, si 'astrology' no da una lista de aspectos pre-calculados,
        // Gemini puede inferir aspectos generales de las posiciones.
        const aspectsData = "Aspectos derivados de las posiciones planetarias (interpretación de Gemini)";
        // Si la librería 'astrology' tiene una función para aspectos, la usaríamos aquí y la formatearíamos.

        finalAstroData = {
            birthDate: birthDate,
            birthTime: birthTime,
            birthPlace: birthPlace,
            userSex: userSex,
            timezoneId: timezoneId,
            rawOffsetHours: rawOffsetSeconds / 3600,
            latitude: latitude,
            longitude: longitude,
            // Datos precisos de la librería de cálculo
            sunSign: chart.planets.sun.sign ? chart.planets.sun.sign.name : 'Desconocido',
            moonSign: chart.planets.moon.sign ? chart.planets.moon.sign.name : 'Desconocido',
            ascendant: chart.houses.house1.sign ? chart.houses.house1.sign.name : 'Desconocido', // Ascendente es la cúspide de la Casa 1
            planetsPositions: planetsData, 
            housesCusps: housesData,      
            keyAspects: aspectsData       
        };

        console.log("Datos astrológicos finales para Gemini (mapeados):", JSON.stringify(finalAstroData, null, 2).substring(0, 500) + "...");


        // --- 4. CONSTRUIR PROMPT PARA GEMINI CON DATOS PRECISOS ---
        const textPrompt = `Genera una interpretación completa de la carta astral basada en los siguientes datos de nacimiento:
        Fecha de Nacimiento: ${finalAstroData.birthDate}
        Hora de Nacimiento: ${finalAstroData.birthTime} (Hora Local)
        Lugar de Nacimiento: ${finalAstroData.birthPlace}
        Sexo del Usuario: ${finalAstroData.userSex}
        Latitud: ${finalAstroData.latitude}
        Longitud: ${finalAstroData.longitude}
        Zona Horaria Identificada: ${finalAstroData.timezoneId} (Offset GMT: ${finalAstroData.rawOffsetHours} horas)

        Y los siguientes datos astrológicos precisos calculados:
        Signo Solar: ${finalAstroData.sunSign}
        Signo Lunar: ${finalAstroData.moonSign}
        Ascendente: ${finalAstroData.ascendant}
        Posiciones de Planetas y Casas: ${finalAstroData.planetsPositions}. Cúspides de Casas: ${finalAstroData.housesCusps}.
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


