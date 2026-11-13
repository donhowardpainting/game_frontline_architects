import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

export type Quality = 'low' | 'medium' | 'high';

const SUN_DIR = new THREE.Vector3(0.78, 0.36, 0.42).normalize();

const skyVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = modelViewMatrix * vec4(position, 0.0);
  gl_Position = (projectionMatrix * vec4(p.xyz, 1.0)).xyww;
}`;
const skyFrag = /* glsl */ `
uniform float uTime; uniform float uFlash; uniform vec3 uSun;
varying vec3 vDir;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<5;i++){ s+=a*noise(p); p*=2.02; a*=0.5; } return s; }
void main(){
  vec3 d = normalize(vDir);
  float h = clamp(d.y, -0.2, 1.0);
  vec3 top = vec3(0.035, 0.05, 0.11), mid = vec3(0.16, 0.14, 0.24), hor = vec3(0.62, 0.34, 0.26);
  vec3 col = mix(hor, mid, smoothstep(0.0, 0.22, h));
  col = mix(col, top, smoothstep(0.15, 0.75, h));
  float sd = max(dot(d, normalize(uSun)), 0.0);
  col += vec3(1.0, 0.5, 0.25) * pow(sd, 6.0) * 0.55;
  col += vec3(1.0, 0.82, 0.6) * pow(sd, 240.0) * 3.0;
  // stars
  vec2 sp = d.xz / (d.y + 0.35) * 60.0;
  float st = step(0.9965, hash(floor(sp))) * smoothstep(0.2, 0.6, h);
  col += vec3(st) * 0.7;
  // ringed moon
  vec3 md = normalize(vec3(-0.45, 0.5, -0.74));
  float m = dot(d, md);
  float disc = smoothstep(0.9925, 0.9935, m);
  vec3 mcol = mix(vec3(0.28,0.32,0.45), vec3(0.75,0.72,0.8), smoothstep(-0.4, 0.6, dot(normalize(d - md * m), normalize(uSun - md * dot(uSun, md)))));
  col = mix(col, mcol, disc * 0.9);
  // storm clouds
  vec2 cp = d.xz / (abs(d.y) + 0.22) * 1.6 + vec2(uTime * 0.012, uTime * 0.004);
  float c = fbm(cp) ; c = smoothstep(0.42, 0.78, c + fbm(cp * 2.7 + 7.0) * 0.25);
  vec3 ccol = mix(vec3(0.07,0.075,0.11), vec3(0.75,0.4,0.3), pow(sd, 3.0) * 0.8);
  ccol += vec3(0.6, 0.7, 1.0) * uFlash * (0.5 + fbm(cp * 3.0));
  col = mix(col, ccol, c * smoothstep(-0.02, 0.2, d.y) * 0.9);
  col = mix(col, vec3(0.17, 0.15, 0.2), smoothstep(0.03, -0.08, d.y));
  gl_FragColor = vec4(col, 1.0);
}`;

const rainVert = /* glsl */ `
uniform float uTime; uniform vec3 uCam; uniform float uScale;
attribute float aSeed;
varying float vA;
void main(){
  vec3 p = position;
  float speed = 46.0 + aSeed * 22.0;
  p.y = mod(p.y - uTime * speed, 60.0);
  p.x += -p.y * 0.12;
  p.xz = mod(p.xz - uCam.xz + 45.0, 90.0) - 45.0 + uCam.xz;
  p.y += uCam.y - 25.0;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uScale * 1.1 / -mv.z, 1.0, 30.0);
  vA = clamp(1.0 - (-mv.z) / 85.0, 0.0, 1.0);
}`;
const rainFrag = /* glsl */ `
varying float vA;
void main(){
  vec2 uv = gl_PointCoord - 0.5;
  float line = smoothstep(0.045, 0.0, abs(uv.x + uv.y * 0.12)) * smoothstep(0.5, 0.1, abs(uv.y));
  gl_FragColor = vec4(0.72, 0.8, 0.95, line * vA * 0.2);
}`;

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uVignette: { value: 0.9 },
    uDamage: { value: 0 },
    uPulse: { value: 0 },
    uTint: { value: new THREE.Vector3(0.3, 0.9, 1.0) },
    uAberr: { value: 0 },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uVignette, uDamage, uPulse, uAberr; uniform vec3 uTint;
    varying vec2 vUv;
    void main(){
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      vec2 off = c * (uAberr * 0.012 + uPulse * 0.02) * r2 * 4.0;
      vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      // gentle filmic grade: cool shadows, warm highlights
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, col * vec3(0.92, 1.0, 1.1), (1.0 - smoothstep(0.0, 0.5, l)) * 0.5);
      col = mix(vec3(l), col, 1.08);
      col *= 1.0 - smoothstep(0.12, 0.75, r2) * uVignette;
      col = mix(col, vec3(0.9, 0.05, 0.05) * (0.4 + l), smoothstep(0.08, 0.5, r2) * uDamage);
      col += uTint * uPulse * (0.25 + smoothstep(0.0, 0.5, r2) * 1.2);
      gl_FragColor = vec4(col, 1.0);
    }`,
};

/** Owns the WebGL renderer, scene scaffolding (sky, lights, weather) and post-processing. */
export class Engine {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 900);
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  flashLight: THREE.DirectionalLight;
  quality: Quality = 'high';
  shake = 0;
  pulse = 0;
  damage = 0;
  aberr = 0;
  lightning = 0;
  onThunder: (() => void) | null = null;
  shadowFocus = new THREE.Vector3();
  shadowExtent = 70;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private final: ShaderPass;
  private sky: THREE.Mesh;
  private rain: THREE.Points;
  private time = 0;
  private nextBolt = 9;
  private boltSeq = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.45;
    this.renderer.localClippingEnabled = true;

    this.scene.fog = new THREE.FogExp2(0x34303f, 0.0046);
    this.scene.add(this.camera);

    this.hemi = new THREE.HemisphereLight(0x8fa8dc, 0x4a3c36, 1.9);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffb489, 3.1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.06;
    this.scene.add(this.sun, this.sun.target);
    this.flashLight = new THREE.DirectionalLight(0xbfd4ff, 0);
    this.flashLight.position.set(-30, 80, -20);
    this.scene.add(this.flashLight);

    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 16),
      new THREE.ShaderMaterial({
        vertexShader: skyVert, fragmentShader: skyFrag, side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
        uniforms: { uTime: { value: 0 }, uFlash: { value: 0 }, uSun: { value: SUN_DIR } },
      }),
    );
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);

    const N = 7000;
    const pos = new Float32Array(N * 3), seed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = Math.random() * 90;
      pos[i * 3 + 1] = Math.random() * 60;
      pos[i * 3 + 2] = Math.random() * 90;
      seed[i] = Math.random();
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    rg.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.rain = new THREE.Points(rg, new THREE.ShaderMaterial({
      vertexShader: rainVert, fragmentShader: rainFrag, transparent: true, depthWrite: false,
      uniforms: { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uScale: { value: 600 } },
    }));
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 20;
    this.scene.add(this.rain);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.62, 0.55, 0.9);
    this.composer.addPass(this.bloom);
    this.final = new ShaderPass(FinalShader);
    this.composer.addPass(this.final);
    this.composer.addPass(new OutputPass());
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setQuality(q: Quality): void {
    this.quality = q;
    this.bloom.enabled = q !== 'low';
    const size = q === 'high' ? 2048 : q === 'medium' ? 1024 : 512;
    this.renderer.shadowMap.enabled = true;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null as any;
    }
    this.rain.visible = true;
    (this.rain.geometry as THREE.BufferGeometry).setDrawRange(0, q === 'low' ? 2500 : 7000);
    this.resize();
  }

  resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    const pr = Math.min(window.devicePixelRatio || 1, this.quality === 'high' ? 1.75 : this.quality === 'medium' ? 1.25 : 1);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** px size of a 1-unit sprite at 1 unit distance, for point-sprite shaders */
  get pointScale(): number {
    return (this.renderer.domElement.height * 0.5) / Math.tan((this.camera.fov * Math.PI) / 360);
  }

  render(dt: number): void {
    this.time += dt;
    // lightning
    this.nextBolt -= dt;
    if (this.nextBolt <= 0) {
      this.nextBolt = 7 + Math.random() * 16;
      this.boltSeq = 0.55;
      this.onThunder?.();
    }
    if (this.boltSeq > 0) {
      this.boltSeq -= dt;
      const k = this.boltSeq;
      this.lightning = k > 0.47 || (k > 0.3 && k < 0.36) ? 1 : Math.max(0, this.lightning - dt * 5);
    } else this.lightning = Math.max(0, this.lightning - dt * 4);
    this.flashLight.intensity = this.lightning * 3.2;
    (this.sky.material as THREE.ShaderMaterial).uniforms.uTime.value = this.time;
    (this.sky.material as THREE.ShaderMaterial).uniforms.uFlash.value = this.lightning;

    // shadow frustum follows the action
    const e = this.shadowExtent;
    const cam = this.sun.shadow.camera;
    if (cam.right !== e) {
      cam.left = -e; cam.right = e; cam.top = e; cam.bottom = -e; cam.near = 1; cam.far = 400;
      cam.updateProjectionMatrix();
    }
    this.sun.target.position.copy(this.shadowFocus);
    this.sun.position.copy(this.shadowFocus).addScaledVector(SUN_DIR, 160);

    // camera shake is applied only for the draw, then removed
    const sx = (Math.random() - 0.5) * this.shake, sy = (Math.random() - 0.5) * this.shake;
    this.camera.translateX(sx);
    this.camera.translateY(sy);
    this.camera.updateMatrixWorld();
    this.shake = Math.max(0, this.shake - dt * (1.6 + this.shake * 3));
    this.pulse = Math.max(0, this.pulse - dt * 1.8);
    this.damage = Math.max(0, this.damage - dt * 0.9);

    this.sky.position.copy(this.camera.position);
    this.sky.scale.setScalar(this.camera.far * 0.9);
    const ru = (this.rain.material as THREE.ShaderMaterial).uniforms;
    ru.uTime.value = this.time;
    ru.uCam.value.set(0, 0, -34).applyQuaternion(this.camera.quaternion).add(this.camera.position);
    ru.uCam.value.y = Math.max(ru.uCam.value.y, 12);
    ru.uScale.value = this.pointScale;

    const fu = this.final.uniforms;
    fu.uPulse.value = this.pulse;
    fu.uDamage.value = Math.min(1, this.damage);
    fu.uAberr.value = this.aberr;
    this.composer.render(dt);
    this.camera.translateX(-sx);
    this.camera.translateY(-sy);
  }

  addShake(amount: number, x?: number, z?: number): void {
    let k = 1;
    if (x !== undefined && z !== undefined) {
      const d = Math.hypot(this.camera.position.x - x, this.camera.position.z - z);
      k = Math.max(0, 1 - d / 110);
    }
    this.shake = Math.min(1.4, this.shake + amount * k);
  }
}
