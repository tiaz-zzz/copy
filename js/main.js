// ============ Arrival.Space 风格 3D 高斯泼溅查看器 — 主逻辑 ============
import * as THREE from 'three';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';

const SPACE = {
    title: 'Pfarrkirche Kefermarkt',
    creator: 'Schindelar3D',
    date: '7月10日',
};

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const splash = $('splash');
const introOverlay = $('intro-overlay');
const progressBar = $('intro-progress');
const progressBarFill = $('intro-progress-bar');
const hud = $('hud');
const drawer = $('drawer');
const searchOverlay = $('search-overlay');
const helpOverlay = $('help-overlay');
const hintCard = $('hint-card');
const toastEl = $('toast');

// ---------- 状态 ----------
let viewer = null;
let entered = false;
let toastTimer = null;
const keys = new Set();
const moveState = { forward: 0, right: 0 };

// ---------- 工具 ----------
function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

function setProgress(p) {
    if (p == null) return;
    // mkkellogg 回调可能传 0..1 或 0..100，统一归一化
    const frac = p > 1 ? p / 100 : p;
    progressBar.classList.add('visible');
    progressBarFill.style.width = Math.min(100, Math.round(frac * 100)) + '%';
}

// ---------- 初始相机（由转换脚本生成的元数据微调） ----------
async function loadSceneMeta() {
    try {
        const r = await fetch('assets/scene-meta.json');
        if (r.ok) return await r.json();
    } catch (e) { /* 使用默认值 */ }
    return null;
}

// ---------- 查看器 ----------
async function initViewer() {
    const meta = await loadSceneMeta();

    const camPos = meta?.camera?.position || [-4.0, 2.6, 12.5];
    const camTarget = meta?.camera?.target || [0, 2.0, 0];
    const camUp = meta?.camera?.up || [0, 1, 0];

    viewer = new GaussianSplats3D.Viewer({
        cameraUp: camUp,
        initialCameraPosition: camPos,
        initialCameraLookAt: camTarget,
        sharedMemoryForWorkers: false,
        dynamicScene: false,
        antialiased: true,
        focalAdjustment: 1.0,
        gaussianCountsWarningThreshold: 3_500_000,
    });

    await viewer.addSplatScene('assets/scene.ply', {
        showLoadingProgress: false,
        onProgress: (p) => setProgress(p),
        progressiveLoad: false,
    });

    // mkkellogg 需要显式启动渲染循环
    viewer.start();

    // 场景就绪：撤掉灰 splash，显示介绍层
    splash.classList.add('hidden');
    setTimeout(() => splash.remove(), 600);
    introOverlay.classList.add('visible');
    setTimeout(() => progressBar.classList.remove('visible'), 700);

    setupMovement();
    requestAnimationFrame(tick);
}

function enterSpace() {
    if (entered) return;
    entered = true;
    introOverlay.classList.add('leaving');
    setTimeout(() => introOverlay.remove(), 900);
    hud.classList.add('visible');
}

// ---------- WASD 移动 ----------
function setupMovement() {
    window.addEventListener('keydown', (e) => {
        if (e.repeat) return;
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        keys.add(e.code);
        updateMoveState();
    });
    window.addEventListener('keyup', (e) => {
        keys.delete(e.code);
        updateMoveState();
    });
    window.addEventListener('blur', () => { keys.clear(); updateMoveState(); });
}

function updateMoveState() {
    moveState.forward =
        (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) -
        (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    moveState.right =
        (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) -
        (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
}

let lastT = 0;
function tick(t) {
    requestAnimationFrame(tick);
    const dt = Math.min((t - lastT) / 1000, 0.1);
    lastT = t;
    if (!viewer || !entered) return;
    if (!moveState.forward && !moveState.right) return;

    const camera = viewer.camera;
    const controls = viewer.controls;
    const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 8 : 3.2) * dt;

    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-8) fwd.set(0, 0, -1);
    fwd.normalize();

    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const delta = new THREE.Vector3()
        .addScaledVector(fwd, moveState.forward * speed)
        .addScaledVector(right, moveState.right * speed);

    camera.position.add(delta);
    if (controls?.target) controls.target.add(delta);
}

// ---------- UI 事件 ----------
function wireUI() {
    // 进入
    introOverlay.addEventListener('click', enterSpace);

    // 提示卡
    $('btn-hint-close').addEventListener('click', () => {
        hintCard.style.display = 'none';
        localStorage.setItem('as-hint-dismissed', '1');
    });
    if (localStorage.getItem('as-hint-dismissed') === '1') hintCard.style.display = 'none';

    // 帮助
    $('btn-help').addEventListener('click', (e) => {
        e.stopPropagation();
        helpOverlay.classList.add('visible');
    });
    $('help-close').addEventListener('click', () => helpOverlay.classList.remove('visible'));
    helpOverlay.addEventListener('click', (e) => {
        if (e.target === helpOverlay) helpOverlay.classList.remove('visible');
    });

    // 抽屉
    const toggleDrawer = (open) => drawer.classList.toggle('open', open);
    $('btn-menu').addEventListener('click', () => toggleDrawer(true));
    $('fab-plus').addEventListener('click', () => toggleDrawer(true));
    $('drawer-collapse').addEventListener('click', () => toggleDrawer(false));
    drawer.querySelectorAll('[data-demo]').forEach((b) =>
        b.addEventListener('click', () => toast('演示项目 — 该功能未包含在此复刻中'))
    );

    // 搜索
    $('btn-search').addEventListener('click', () => {
        searchOverlay.classList.add('visible');
        setTimeout(() => $('search-input').focus(), 60);
    });
    $('search-close').addEventListener('click', () => searchOverlay.classList.remove('visible'));
    searchOverlay.addEventListener('click', (e) => {
        if (e.target === searchOverlay) searchOverlay.classList.remove('visible');
    });
    $('search-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') toast('没有找到更多匹配的空间');
    });

    // 点赞 / 收藏 / 评论 / 分享 / 声音
    let likeCount = 49, saveCount = 32;
    $('btn-like').addEventListener('click', function () {
        this.classList.toggle('liked');
        likeCount += this.classList.contains('liked') ? 1 : -1;
        $('like-count').textContent = likeCount;
    });
    $('btn-save').addEventListener('click', function () {
        this.classList.toggle('saved');
        saveCount += this.classList.contains('saved') ? 1 : -1;
        $('save-count').textContent = saveCount;
        toast(this.classList.contains('saved') ? '已收藏此空间' : '已取消收藏');
    });
    $('btn-comment').addEventListener('click', () => toast('登录后查看 13 条评论'));
    $('btn-share').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(location.href);
            toast('链接已复制到剪贴板');
        } catch {
            toast('复制失败，请手动复制地址栏链接');
        }
    });
    $('btn-audio').addEventListener('click', () => toast('此空间没有环境音'));

    // ESC 关闭浮层
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            searchOverlay.classList.remove('visible');
            helpOverlay.classList.remove('visible');
            toggleDrawer(false);
        }
    });
}

wireUI();

// 调试钩子
window.__errors = [];
window.addEventListener('error', (e) => window.__errors.push(String(e.message || e)));
window.addEventListener('unhandledrejection', (e) => window.__errors.push('rejection: ' + String(e.reason)));

initViewer().then(() => { window.__viewer = viewer; }).catch((err) => {
    console.error(err);
    window.__errors.push('initViewer: ' + String(err?.message || err));
    splash.innerHTML = '<div style="color:#333;font:600 16px/1.6 var(--font),sans-serif;text-align:center;padding:24px">场景加载失败<br><small>' +
        String(err?.message || err).replace(/[<>]/g, '') + '</small></div>';
});
