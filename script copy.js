import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.module.js';

let scene, camera, renderer, detector, background, uniforms;

init();
animate();

function init() {
  // Scene & Camera
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.z = 6;

  // Renderer
  renderer = new THREE.WebGLRenderer({
    canvas: document.getElementById('three-canvas'),
    antialias: true,
    alpha: true
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);

  // Background Shader
  const bgGeo = new THREE.PlaneGeometry(20, 20);
  uniforms = {
    time: { value: 0.0 }
  };
  const bgMat = new THREE.ShaderMaterial({
    vertexShader: document.getElementById('vertexShader').textContent,
    fragmentShader: document.getElementById('fragmentShader').textContent,
    uniforms: uniforms,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  background = new THREE.Mesh(bgGeo, bgMat);
  background.rotation.x = -Math.PI / 2;
  background.position.y = -5;
  scene.add(background);

  // Lighting
  const light = new THREE.DirectionalLight(0xffffff, 1);
  light.position.set(5, 5, 5);
  scene.add(light);
  scene.add(new THREE.AmbientLight(0xffffff, 0.4));

  // Detector Geometry
  detector = createDetector();
  scene.add(detector);

  // Listeners
  window.addEventListener('resize', onWindowResize);
  window.addEventListener('scroll', onScroll);
}

function createDetector() {
  const group = new THREE.Group();

  // CMS-inspired colors and sizes
  const layers = [
    { radius: 0.5, height: 2, color: 0xffffff, opacity: 0.3 }, // Inner Tracker
    { radius: 1.0, height: 2.5, color: 0x44aaff, opacity: 0.3 }, // ECAL
    { radius: 1.5, height: 3, color: 0xff4444, opacity: 0.2 }, // HCAL
    { radius: 2.2, height: 3.5, color: 0x44ff44, opacity: 0.2 }, // Muon System
  ];

  layers.forEach(layer => {
    const geo = new THREE.CylinderGeometry(layer.radius, layer.radius, layer.height, 64, 1, true);
    const mat = new THREE.MeshStandardMaterial({
      color: layer.color,
      transparent: true,
      opacity: layer.opacity,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geo, mat);
    group.add(mesh);
  });

  // Endcap disks
  const endcapRadius = 2.3;
  const endcapMat = new THREE.MeshStandardMaterial({ color: 0xffffff, opacity: 0.1, transparent: true });
  [-1.75, 1.75].forEach(z => {
    const diskGeo = new THREE.CircleGeometry(endcapRadius, 64);
    const disk = new THREE.Mesh(diskGeo, endcapMat);
    disk.rotation.x = -Math.PI / 2;
    disk.position.z = z;
    group.add(disk);
  });

  // Add simulated collision tracks
  const trackCount = 20;
  for (let i = 0; i < trackCount; i++) {
    const track = createParticleTrack();
    group.add(track);
  }

  return group;
}

function createParticleTrack() {
  const points = [];
  const angle = Math.random() * Math.PI * 2;
  const spread = 2.5;

  for (let i = 0; i < 5; i++) {
    const r = i * (spread / 5) + Math.random() * 0.2;
    const x = r * Math.cos(angle + i * 0.1);
    const y = r * (Math.random() - 0.5) * 0.5;
    const z = r * Math.sin(angle + i * 0.1);
    points.push(new THREE.Vector3(x, y, z));
  }

  const curve = new THREE.CatmullRomCurve3(points);
  const tubeGeo = new THREE.TubeGeometry(curve, 20, 0.02, 8, false);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffff00 });
  return new THREE.Mesh(tubeGeo, mat);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function onScroll() {
  const scrollY = window.scrollY;
  if (detector) {
    detector.rotation.y = scrollY * 0.002;
    detector.rotation.x = scrollY * 0.001;
  }
}

function animate() {
  requestAnimationFrame(animate);
  uniforms.time.value = performance.now() / 1000;
  renderer.render(scene, camera);
}
