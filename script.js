// --- Configurações Cerrado Tech ---
const ptBrMap = {
    'person': 'Pessoa', 'cell phone': 'Celular', 'cup': 'Copo', 'chair': 'Cadeira', 
    'bottle': 'Garrafa', 'laptop': 'Notebook', 'keyboard': 'Teclado', 'mouse': 'Mouse'
};

function translateLabel(engLabel) { return ptBrMap[engLabel] || engLabel; }
const colorMap = { 'objects': '#22c55e', 'pose': '#f59e0b', 'face': '#3b82f6' };

// Elementos DOM
const video = document.getElementById('webcam');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const loader = document.getElementById('loader');
const cameraPrompt = document.getElementById('camera-prompt');
const logList = document.getElementById('log-list');

const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnSnapshot = document.getElementById('btn-snapshot');
const cameraSelect = document.getElementById('camera-select');
const moduleSelect = document.getElementById('ai-module');
const thresholdSlider = document.getElementById('threshold-slider');
const thresholdVal = document.getElementById('threshold-val');

// HUD
const hud = document.getElementById('hud');
const hudFps = document.getElementById('hud-fps');
const hudInference = document.getElementById('hud-inference');

// Estado
let isDetecting = false;
let animationId = null;
let stream = null;
let lastDetections = [];
let currentThreshold = 0.60;
let currentMode = 'objects';

// Modelos Carregados
const models = { objects: null, pose: null, face: false };

// FPS
let frameCount = 0;
let lastFpsUpdate = performance.now();

// --- Inicialização ---
async function init() {
    await getCameras();
    
    // Inicia carregando apenas o modelo padrão para não travar
    await switchModule('objects');
}

// Troca de Módulo
async function switchModule(mode) {
    currentMode = mode;
    updateStatus('loading', `Carregando Módulo: ${mode}...`);
    loader.style.display = 'flex';
    btnStart.disabled = true;

    try {
        if (mode === 'objects' && !models.objects) {
            models.objects = await cocoSsd.load();
        } 
        else if (mode === 'pose' && !models.pose) {
            const detectorConfig = { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING };
            models.pose = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, detectorConfig);
        } 
        else if (mode === 'face' && !models.face) {
            // Carrega os pesos da rede do face-api de um repositório confiável via URL
            const MODEL_URL = 'https://justadudewhohacks.github.io/face-api.js/models';
            await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
            await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
            await faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL);
            models.face = true;
        }

        loader.style.display = 'none';
        btnStart.disabled = false;
        updateStatus('ready', 'Módulo pronto. Aguardando ativação da câmera.');
        
        if (isDetecting) {
            // Se já estava detectando, limpa a tela para o novo módulo
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    } catch (e) {
        console.error("Erro ao carregar modelo:", e);
        document.getElementById('loader-text').innerText = "Erro ao carregar IA. Verifique conexão.";
        document.getElementById('loader-text').style.color = "var(--danger-color)";
    }
}

moduleSelect.addEventListener('change', (e) => {
    switchModule(e.target.value);
});

// --- Câmera ---
async function getCameras() {
    try {
        await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
            .then(s => s.getTracks().forEach(t => t.stop()));
        
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === 'videoinput');
        
        cameraSelect.innerHTML = '';
        if (videoDevices.length === 0) {
            cameraSelect.innerHTML = '<option value="">Câmera Indisponível</option>';
            return;
        }

        videoDevices.forEach(d => {
            const option = document.createElement('option');
            option.value = d.deviceId;
            option.text = d.label || `Câmera ${cameraSelect.length + 1}`;
            cameraSelect.appendChild(option);
        });
        cameraSelect.disabled = false;
    } catch (err) {
        cameraSelect.innerHTML = '<option value="">Permissão Necessária</option>';
    }
}

async function startCamera() {
    try {
        btnStart.disabled = true;
        cameraSelect.disabled = true;
        moduleSelect.disabled = true;
        
        const deviceId = cameraSelect.value;
        const constraints = { video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' } };

        stream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = stream;
        
        video.onloadeddata = () => {
            cameraPrompt.style.display = 'none';
            btnStop.disabled = false;
            btnSnapshot.disabled = false;
            hud.style.display = 'flex';
            
            resizeCanvas();
            updateStatus('active', `Analisando: ${currentMode}`);
            
            isDetecting = true;
            detectFrame();
        };
    } catch (error) {
        alert("Erro ao abrir a câmera.");
        btnStart.disabled = false;
        cameraSelect.disabled = false;
        moduleSelect.disabled = false;
    }
}

function stopCamera() {
    isDetecting = false;
    if (animationId) cancelAnimationFrame(animationId);
    if (stream) stream.getTracks().forEach(t => t.stop());
    video.srcObject = null;
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    cameraPrompt.style.display = 'flex';
    hud.style.display = 'none';
    
    btnStart.disabled = false;
    btnStop.disabled = true;
    btnSnapshot.disabled = true;
    cameraSelect.disabled = false;
    moduleSelect.disabled = false;
    
    updateStatus('ready', 'Sistema Parado.');
}

function resizeCanvas() {
    canvas.width = video.clientWidth;
    canvas.height = video.clientHeight;
}

// --- Frame Loop ---
async function detectFrame() {
    if (!isDetecting) return;
    if (canvas.width !== video.clientWidth || canvas.height !== video.clientHeight) resizeCanvas();

    const t0 = performance.now();
    let logs = [];
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    try {
        if (currentMode === 'objects' && models.objects) {
            const predictions = await models.objects.detect(video);
            logs = renderObjects(predictions);
        } 
        else if (currentMode === 'pose' && models.pose) {
            const poses = await models.pose.estimatePoses(video);
            logs = renderPose(poses);
        }
        else if (currentMode === 'face' && models.face) {
            const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions())
                                            .withFaceLandmarks().withFaceExpressions();
            logs = renderFace(detections);
        }
    } catch (e) { console.error("Erro na inferência:", e); }

    const t1 = performance.now();
    hudInference.innerText = `${Math.round(t1 - t0)}ms`;
    
    updateLogs(logs);
    calculateFPS();

    if (isDetecting) animationId = requestAnimationFrame(detectFrame);
}

function calculateFPS() {
    const now = performance.now();
    frameCount++;
    if (now - lastFpsUpdate >= 1000) {
        hudFps.innerText = Math.round((frameCount * 1000) / (now - lastFpsUpdate));
        frameCount = 0;
        lastFpsUpdate = now;
    }
}

// --- RENDERIZADORES ESPECÍFICOS ---

function getScale() {
    const vR = video.videoWidth / video.videoHeight;
    const eR = video.clientWidth / video.clientHeight;
    let s = 1, ox = 0, oy = 0;
    if (vR > eR) {
        s = video.clientWidth / video.videoWidth;
        oy = (video.clientHeight - (video.videoHeight * s)) / 2;
    } else {
        s = video.clientHeight / video.videoHeight;
        ox = (video.clientWidth - (video.videoWidth * s)) / 2;
    }
    return { s, ox, oy };
}

// 1. Objetos
function renderObjects(predictions) {
    const { s, ox, oy } = getScale();
    const color = colorMap['objects'];
    const logs = [];

    predictions.filter(p => p.score >= currentThreshold).forEach(p => {
        const [x, y, w, h] = p.bbox;
        const ptName = translateLabel(p.class);
        const ax = x * s + ox, ay = y * s + oy, aw = w * s, ah = h * s;

        ctx.strokeStyle = color; ctx.lineWidth = 3;
        ctx.strokeRect(ax, ay, aw, ah);
        
        ctx.fillStyle = color; ctx.font = '14px Inter';
        const txt = `${ptName} ${Math.round(p.score * 100)}%`;
        ctx.fillRect(ax, ay - 22, ctx.measureText(txt).width + 10, 22);
        ctx.fillStyle = '#fff'; ctx.fillText(txt, ax + 5, ay - 18);
        logs.push(ptName);
    });
    return logs;
}

// 2. Postura (MoveNet)
function renderPose(poses) {
    const { s, ox, oy } = getScale();
    const color = colorMap['pose'];
    const logs = [];

    poses.forEach(pose => {
        if (pose.score < currentThreshold) return;

        // Desenhar Esqueleto
        const keypoints = pose.keypoints;
        ctx.fillStyle = color;
        keypoints.forEach(kp => {
            if (kp.score > 0.3) {
                ctx.beginPath();
                ctx.arc(kp.x * s + ox, kp.y * s + oy, 5, 0, 2 * Math.PI);
                ctx.fill();
            }
        });

        // Heurísticas de Postura
        const getPt = (name) => keypoints.find(k => k.name === name);
        const lShoulder = getPt('left_shoulder'), rShoulder = getPt('right_shoulder');
        const lWrist = getPt('left_wrist'), rWrist = getPt('right_wrist');
        const lHip = getPt('left_hip'), rHip = getPt('right_hip');
        const lKnee = getPt('left_knee'), rKnee = getPt('right_knee');

        let isArmsOpen = false;
        let isSitting = false;

        if (lShoulder && rShoulder && lWrist && rWrist && lShoulder.score > 0.4 && lWrist.score > 0.4) {
            const shoulderDist = Math.abs(lShoulder.x - rShoulder.x);
            const wristDist = Math.abs(lWrist.x - rWrist.x);
            // Se os pulsos estão bem mais distantes que os ombros
            if (wristDist > shoulderDist * 1.8) {
                isArmsOpen = true;
                logs.push("Braços Abertos");
            } else if (wristDist < shoulderDist * 0.5) {
                logs.push("Braços Fechados/Cruzados");
            }
        }

        if (lHip && lKnee && lHip.score > 0.4 && lKnee.score > 0.4) {
            const verticalDist = Math.abs(lHip.y - lKnee.y);
            const horizontalDist = Math.abs(lHip.x - lKnee.x);
            // Se o joelho está no mesmo nível vertical do quadril, está sentado.
            // Se está bem abaixo, está em pé.
            if (verticalDist < 50 && horizontalDist > 30) {
                isSitting = true;
                logs.push("Pessoa Sentada");
            } else if (verticalDist > 100) {
                logs.push("Pessoa em Pé");
            }
        }

        // Desenhar Texto Base
        if (lShoulder) {
            const ax = lShoulder.x * s + ox;
            const ay = (lShoulder.y - 50) * s + oy;
            const txt = isSitting ? "Sentado" : "Em Pé";
            ctx.fillStyle = color;
            ctx.fillRect(ax, ay - 20, 100, 25);
            ctx.fillStyle = '#fff';
            ctx.fillText(txt, ax + 5, ay - 5);
        }
    });
    return logs;
}

// 3. Rosto e Expressões (FaceAPI)
function renderFace(detections) {
    const { s, ox, oy } = getScale();
    const color = colorMap['face'];
    const logs = [];

    // O faceapi detecta baseado no tamanho original do video. Precisamos redimensionar.
    const resizedDetections = faceapi.resizeResults(detections, { width: video.videoWidth, height: video.videoHeight });

    resizedDetections.forEach(det => {
        if (det.detection.score < currentThreshold) return;

        const box = det.detection.box;
        const ax = box.x * s + ox, ay = box.y * s + oy, aw = box.width * s, ah = box.height * s;

        ctx.strokeStyle = color; ctx.lineWidth = 2;
        ctx.strokeRect(ax, ay, aw, ah);

        // Expressão Dominante
        const expressions = det.expressions;
        const maxExp = Object.keys(expressions).reduce((a, b) => expressions[a] > expressions[b] ? a : b);
        
        let translatedExp = "Neutro";
        if (maxExp === 'happy') { translatedExp = "Sorrindo 😊"; logs.push("Sorrindo"); }
        if (maxExp === 'sad') { translatedExp = "Triste 😢"; logs.push("Triste"); }
        if (maxExp === 'angry') { translatedExp = "Irritado 😠"; logs.push("Irritado"); }
        if (maxExp === 'surprised') { translatedExp = "Surpreso 😲"; logs.push("Surpreso"); }
        if (maxExp === 'neutral') logs.push("Rosto Neutro");

        // Análise de Olhos Fechados via Landmarks (EAR - Eye Aspect Ratio)
        const landmarks = det.landmarks;
        const leftEye = landmarks.getLeftEye();
        const rightEye = landmarks.getRightEye();
        
        // Distância vertical entre os pontos do olho
        const leH = Math.abs(leftEye[1].y - leftEye[5].y);
        const leW = Math.abs(leftEye[0].x - leftEye[3].x);
        const EAR = leH / leW;

        let eyeState = "Olhos Abertos";
        if (EAR < 0.25) { // Valor empírico para olho fechado
            eyeState = "Olhos Fechados";
            logs.push("Olhos Fechados");
        } else {
            logs.push("Olhos Abertos");
        }

        // Desenhar HUD Rosto
        ctx.fillStyle = color;
        ctx.fillRect(ax, ay - 45, 150, 45);
        ctx.fillStyle = '#fff';
        ctx.font = '14px Inter';
        ctx.fillText(translatedExp, ax + 5, ay - 30);
        ctx.fillText(eyeState, ax + 5, ay - 10);
    });

    return logs;
}

// --- Interface ---
function updateStatus(state, message) {
    document.getElementById('status-text').innerText = message;
    const dot = document.getElementById('status-dot');
    dot.className = 'status-dot'; 
    if (state === 'loading') dot.classList.add('loading');
    if (state === 'active') dot.classList.add('active');
}

function updateLogs(detections) {
    // Remove duplicatas
    const unique = [...new Set(detections)];
    const currentString = unique.sort().join(',');
    const lastString = lastDetections.sort().join(',');
    
    if (currentString !== lastString) {
        logList.innerHTML = ''; 
        if (unique.length === 0) {
            logList.innerHTML = '<li class="empty-log">Aguardando IA...</li>';
        } else {
            unique.forEach(key => {
                const li = document.createElement('li');
                li.innerHTML = `<span>${key}</span> <span style="color:var(--accent-color);">✓</span>`;
                logList.appendChild(li);
            });
        }
        lastDetections = unique;
    }
}

// --- Snapshot ---
function takeSnapshot() {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvas.width; tempCanvas.height = canvas.height;
    const tCtx = tempCanvas.getContext('2d');
    tCtx.fillStyle = '#000000'; tCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);

    const { s, ox, oy } = getScale();
    const vR = video.videoWidth / video.videoHeight;
    const eR = video.clientWidth / video.clientHeight;
    
    if (vR > eR) {
        tCtx.drawImage(video, 0, oy, video.clientWidth, video.videoHeight * s);
    } else {
        tCtx.drawImage(video, ox, 0, video.videoWidth * s, video.clientHeight);
    }

    tCtx.drawImage(canvas, 0, 0);

    const a = document.createElement('a');
    a.href = tempCanvas.toDataURL('image/png');
    a.download = `CerradoTech_IA_${currentMode}_${new Date().getTime()}.png`;
    a.click();
}

window.addEventListener('resize', () => { if (isDetecting) resizeCanvas(); });
btnStart.addEventListener('click', startCamera);
btnStop.addEventListener('click', stopCamera);
btnSnapshot.addEventListener('click', takeSnapshot);

cameraSelect.addEventListener('change', () => {
    if (isDetecting) { stopCamera(); setTimeout(startCamera, 300); }
});

thresholdSlider.addEventListener('input', (e) => {
    thresholdVal.innerText = `${e.target.value}%`;
    currentThreshold = parseInt(e.target.value) / 100;
});

window.addEventListener('DOMContentLoaded', init);
