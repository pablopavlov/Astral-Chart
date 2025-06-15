// functions/index.js

// Importa las dependencias necesarias para Firebase Functions.
const functions = require('firebase-functions');
// Importa la librería de Google Generative AI para interactuar con Gemini.
const { GoogleGenerativeLanguageServiceClient } = require('@google/generative-ai');
// Importa swisseph-js para realizar cálculos astrológicos.
const swisseph = require('swisseph-js');
// Importa node-fetch para realizar peticiones HTTP (necesario para las APIs externas)
const fetch = require('node-fetch');

// Inicializa el cliente de Gemini.
// Las claves API para Firebase Functions se acceden de forma segura a través de functions.config().
const genAI = new GoogleGenerativeLanguageServiceClient({
    auth: {
        // Acceso a la clave Gemini configurada a través de firebase functions:config:set gemini.api_key="..."`
        apiKey: functions.config().gemini.api_key,
    },
});

const TEXT_MODEL_NAME = "gemini-2.0-flash";

/**
 * Esta es tu Firebase Function principal.
 * Se activará cada vez que se haga una solicitud HTTP (POST) a su URL desplegada.
 * El nombre de la función exportada (`generateAstralChart`) debe coincidir con el nombre
 * de la función que configurarás en `firebase.json` y que tu frontend llamará.
 */
exports.generateAstralChart = functions.https.onRequest(async (req, res) => {
    console.log("Firebase Function 'generateAstralChart' llamada.");

    // Configura los encabezados CORS para permitir solicitudes desde tu frontend en Firebase Hosting
    // o GitHub Pages. Esto es crucial para la comunicación entre dominios.
    res.set('Access-Control-Allow-Origin', '*'); // Puedes restringirlo a 'https://YOUR_FIREBASE_HOSTING_DOMAIN.web.app' o 'https://your-github-pages-domain.github.io' para mayor seguridad.
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '3600'); // Cachea la respuesta preflight por 1 hora

    // Maneja las solicitudes OPTIONS (preflight requests de CORS).
    if (req.method === 'OPTIONS') {
        console.log("Solicitud OPTIONS (CORS preflight) recibida. Respondiendo 200 OK.");
        return res.status(200).send();
    }

    // Asegúrate de que la solicitud entrante sea un método POST.
    if (req.method !== 'POST') {
        console.log(`Método no permitido: ${req.method}. Solo se aceptan solicitudes POST.`);
        return res.status(405).json({ message: 'Método no permitido. Solo se aceptan solicitudes POST.' });
    }

    // Verifica que las claves API necesarias estén configuradas en las variables de entorno de Firebase Functions.
    if (!functions.config().gemini || !functions.config().gemini.api_key) {
        console.error('Error: Firebase Function GEMINI_API_KEY no configurada.');
        return res.status(500).json({ message: 'Error interno del servidor: Clave API GEMINI_API_KEY no configurada en Firebase Functions.' });
    }
    if (!functions.config().google_maps || !functions.config().google_maps.api_key) {
        console.error('Error: Firebase Function GOOGLE_MAPS_API_KEY no configurada.');
        return res.status(500).json({ message: 'Error interno del servidor: Clave API GOOGLE_MAPS_API_KEY no configurada en Firebase Functions.' });
    }

    try {
        const { birthDate, birthTime, birthPlace, userSex, language } = req.body;

        // Valida que todos los datos esenciales estén presentes.
        if (!birthDate || !birthTime || !birthPlace || !userSex || !language) {
            console.log("Datos de entrada faltantes:", req.body);
            return res.status(400).json({ message: 'Datos de nacimiento o sexo incompletos.' });
        }

        let latitude, longitude;
        let timezoneId, rawOffsetSeconds;

        // 1. LLAMADA A LA API DE GEOCODIFICACIÓN (OpenStreetMap Nominatim)
        console.log(`Intentando geocodificar lugar con Nominatim: ${birthPlace}`);
        const nominatimUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(birthPlace)}&limit=1`;

        try {
            const nominatimResponse = await fetch(nominatimUrl, {
                headers: {
                    'User-Agent': 'CartaAstralApp/1.0 (papastorguerra@gmail.com)' // <<-- ¡REEMPLAZAR con tu email o nombre de app real!
                }
            });

            if (!nominatimResponse.ok) {
                throw new Error(`Error HTTP de Nominatim: ${nominatimResponse.status} ${nominatimResponse.statusText}`);
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

        // 2. LLAMADA A LA API DE ZONA HORARIA (Google Maps Time Zone API)
        console.log(`Intentando obtener zona horaria con Google Maps Time Zone API para Lat ${latitude}, Lng ${longitude}`);

        // Acceso a la clave de Google Maps configurada en Firebase Functions
        const googleMapsApiKey = functions.config().google_maps.api_key;

        const localDateTimeString = `${birthDate}T${birthTime}:00`;
        const localDate = new Date(localDateTimeString);

        if (isNaN(localDate.getTime())) {
            console.error(`Error de parseo de fecha/hora: ${birthDate}T${birthTime}`);
            return res.status(400).json({ message: 'Formato de fecha u hora de nacimiento inválido.' });
        }

        const timestamp = Math.floor(localDate.getTime() / 1000); // Timestamp en segundos

        const googleTimeZoneUrl = `https://maps.googleapis.com/maps/api/timezone/json?location=${latitude},${longitude}&timestamp=${timestamp}&key=${googleMapsApiKey}`;

        try {
            const timezoneResponse = await fetch(googleTimeZoneUrl);
            if (!timezoneResponse.ok) {
                throw new Error(`Error HTTP de Google Time Zone API: ${timezoneResponse.status} ${timezoneResponse.statusText}`);
            }

            const timezoneData = await timezoneResponse.json();

            if (timezoneData.status === 'OK') {
                timezoneId = timezoneData.timeZoneId;
                // rawOffset incluye el offset estándar y dstOffset el horario de verano
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

        // 3. CÁLCULO ASTROLÓGICO (Utilizando la librería 'swisseph-js')
        console.log("Realizando cálculos astrológicos con la librería 'swisseph-js'...");

        // Configuración para swisseph-js
        const julianDay = swisseph.swe_julday(
            localDate.getFullYear(),
            localDate.getMonth() + 1,
            localDate.getDate(),
            localDate.getHours() + (rawOffsetSeconds / 3600), // Convertir hora local a UTC para swisseph
            swisseph.SEFLG_SWIEPH // Usar efemérides suizas (por defecto)
        );

        // Obtener posiciones de planetas
        const planets = [
            swisseph.SE_SUN, swisseph.SE_MOON, swisseph.SE_MERCURY, swisseph.SE_VENUS,
            swisseph.SE_MARS, swisseph.SE_JUPITER, swisseph.SE_SATURN, swisseph.SE_URANUS,
            swisseph.SE_NEPTUNE, swisseph.SE_PLUTO
        ];

        const planetData = {};
        const planetNames = {
            [swisseph.SE_SUN]: 'Sol', [swisseph.SE_MOON]: 'Luna', [swisseph.SE_MERCURY]: 'Mercurio',
            [swisseph.SE_VENUS]: 'Venus', [swisseph.SE_MARS]: 'Marte', [swisseph.SE_JUPITER]: 'Júpiter',
            [swisseph.SE_SATURN]: 'Saturno', [swisseph.SE_URANUS]: 'Urano', [swisseph.SE_NEPTUNE]: 'Neptuno',
            [swisseph.SE_PLUTO]: 'Plutón'
        };
        const signNames = ['Aries', 'Tauro', 'Géminis', 'Cáncer', 'Leo', 'Virgo', 'Libra', 'Escorpio', 'Sagitario', 'Capricornio', 'Acuario', 'Piscis'];

        for (const planet of planets) {
            const pos = swisseph.swe_calc_ut(julianDay, planet, swisseph.SEFLG_SWIEPH);
            const longitude = pos[0];
            const signIndex = Math.floor(longitude / 30);
            const sign = signNames[signIndex];
            const degree = (longitude % 30).toFixed(2);
            planetData[planetNames[planet]] = { sign, degree, longitude };
        }

        // Obtener casas y cúspides (Placidus House System)
        const ascmc = swisseph.swe_houses(julianDay, latitude, longitude, 'P'); // 'P' for Placidus
        const houseCusps = ascmc.house;
        const ascendantLon = ascmc.ascendant; // Ascendente
        const mcLon = ascmc.mc; // Medio Cielo

        const housesData = {};
        for (let i = 1; i <= 12; i++) {
            const cuspLon = houseCusps[i];
            const signIndex = Math.floor(cuspLon / 30);
            const sign = signNames[signIndex];
            const degree = (cuspLon % 30).toFixed(2);
            housesData[`Casa ${i}`] = { sign, degree, longitude: cuspLon };
        }

        const ascendantSignIndex = Math.floor(ascendantLon / 30);
        const ascendantSign = signNames[ascendantSignIndex];
        const mcSignIndex = Math.floor(mcLon / 30);
        const mcSign = signNames[mcSignIndex];


        // Determinar el Signo Solar (con corrección para el signo)
        const sunLon = planetData['Sol'].longitude;
        const sunSignIndex = Math.floor(sunLon / 30);
        const sunSign = signNames[sunSignIndex];

        // Determinar el Signo Lunar
        const moonLon = planetData['Luna'].longitude;
        const moonSignIndex = Math.floor(moonLon / 30);
        const moonSign = signNames[moonSignIndex];

        // Mapear planetas para el prompt de Gemini
        const planetsPrompt = Object.keys(planetData).map(planetName => {
            const p = planetData[planetName];
            // Para las casas, necesitamos calcular en qué casa cae cada planeta.
            // swisseph.swe_houses_pos para calcular la casa de un punto.
            const housePos = swisseph.swe_house_pos(houseCusps, latitude, p.longitude);
            return `${planetName} en ${p.sign} a ${p.degree}° en Casa ${Math.floor(housePos)}`;
        }).join(', ');

        const housesCuspsPrompt = Object.keys(housesData).map(houseName => {
            const h = housesData[houseName];
            return `${houseName} en ${h.sign} a ${h.degree}°`;
        }).join(', ');


        console.log("Cálculos astrológicos con 'swisseph-js' completados.");

        const finalAstroData = {
            birthDate: birthDate,
            birthTime: birthTime,
            birthPlace: birthPlace,
            userSex: userSex,
            timezoneId: timezoneId,
            rawOffsetHours: rawOffsetSeconds / 3600,
            latitude: latitude,
            longitude: longitude,
            // Datos precisos de la librería de cálculo
            sunSign: sunSign,
            moonSign: moonSign,
            ascendant: ascendantSign, // Ascendente
            mc: mcSign, // Medio Cielo
            planetsPositions: planetsPrompt, // Formato más descriptivo
            housesCusps: housesCuspsPrompt, // Formato más descriptivo
            keyAspects: "Aspectos derivados de las posiciones planetarias (interpretación de Gemini)" // Gemini generará los aspectos
        };

        console.log("Datos astrológicos finales para Gemini (mapeados):", JSON.stringify(finalAstroData, null, 2).substring(0, 500) + "...");

        // 4. CONSTRUIR PROMPT PARA GEMINI CON DATOS PRECISOS
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
Medio Cielo: ${finalAstroData.mc}
Posiciones de Planetas: ${finalAstroData.planetsPositions}.
Cúspides de Casas: ${finalAstroData.housesCusps}.
Aspectos Clave: ${finalAstroData.keyAspects}

La interpretación debe ser altamente profesional, profunda, narrativa y psicológicamente atractiva. Utiliza principios de Neuro-Linguistic Programming (PNL) para inspirar, captar la atención y motivar el crecimiento personal, fomentando una sensación agradable, mental y psicológicamente enriquecedora para el lector. El tono debe ser directo ("tú"). La interpretación debe ser sensible al género del usuario.

La interpretación debe estructurarse con las siguientes 28 secciones exactas y en este orden. ¡No incluyas ninguna sección o mención a Eneagrama, Chakras, pareja ideal o imágenes!

1. Los Componentes Fundamentales de tu Carta Astral
2. La Interpretación de tu Carta Astral: Un Viaje Personal
3. Beneficios de Conocer tu Carta Astral: Tu Poder Interior
4. Análisis Completo, Profundo y Detallado de tu Mapa Cósmico
5. Síntesis General de tu Perfil Astrológico: Tu Esencia Única
6. La Dinámica de la Armonía: Integrando tus Luces
7. Un Enfoque Positivo para la Pasión y la Vida: Tu Energía Radiante
8. La Sexualidad: Un Viaje de Conexión Profunda y Placer
9. La Relación Contigo Mismo
10. El Aspecto Social: Tu Brillo en la Conexión Humana
11. El Aspecto Laboral: Tu Propósito en Acción
12. El Aspecto Artístico: La Danza de tu Creatividad
13. El Ego: Tu Guardián y Maestro Interior
14. El Verdadero Yo: La Voz de tu Alma
15. Sanar la Herida (Quirón) Abrazando tu Poder de Transformación
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
        // Manejo de errores centralizado: Si ocurre algún error en
        // cualquier etapa, se registra y se notifica al frontend.
        console.error('Error general en la función sin servidor:', error);
        res.status(500).json({ message: `Error interno del servidor al procesar la solicitud de la carta astral. Por favor, inténtalo de nuevo más tarde o contacta al soporte. Detalles técnicos: ${error.message}` });
    }
});


