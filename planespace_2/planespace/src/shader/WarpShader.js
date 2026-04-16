/**
 * WarpShader — compiles and drives the WebGL2 warp fragment shader
 */

const VERT_SRC = `#version 300 es
in vec2 a_position;
out vec2 vUV;
void main() {
  vUV = a_position * 0.5 + 0.5;
  // Flip Y: WebGL UV origin is bottom-left, canvas is top-left
  vUV.y = 1.0 - vUV.y;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision highp float;

uniform sampler2D T_scene;
uniform sampler2D T_depth;
uniform vec2 viewerAngle;
uniform float warpStrength;
uniform vec2 resolution;
uniform bool edgeClamping;
uniform bool chromaticOffset;
uniform float chromaticStrength;
uniform float vignetteStrength;

in vec2 vUV;
out vec4 fragColor;

void main() {
  float depth = texture(T_depth, vUV).r;

  // Parallax offset: near pixels (depth=1) shift more
  vec2 offset = viewerAngle * depth * warpStrength;

  vec2 sampleUV = vUV + offset;

  // Edge clamping: clamp UV to prevent wrap-around artifacts
  if (edgeClamping) {
    sampleUV = clamp(sampleUV, vec2(0.001), vec2(0.999));
  }

  vec4 color;

  if (chromaticOffset) {
    // RGB split: near elements get slight color fringing for realism
    float ca = depth * chromaticStrength;
    float r = texture(T_scene, sampleUV + vec2(ca, 0.0)).r;
    float g = texture(T_scene, sampleUV).g;
    float b = texture(T_scene, sampleUV - vec2(ca, 0.0)).b;
    float a = texture(T_scene, sampleUV).a;
    color = vec4(r, g, b, a);
  } else {
    color = texture(T_scene, sampleUV);
  }

  // Vignette: darken edges at extreme angles
  if (vignetteStrength > 0.0) {
    vec2 uv2 = vUV * 2.0 - 1.0;
    float vignette = 1.0 - dot(uv2, uv2) * vignetteStrength * length(viewerAngle);
    color.rgb *= clamp(vignette, 0.0, 1.0);
  }

  fragColor = color;
}`;

export class WarpShader {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.shaderOpts = options.shader || {};

    this._gl = null;
    this._program = null;
    this._uniforms = {};
    this._textures = { scene: null, depth: null };
    this._vao = null;

    // Temporal smoothing for depth texture
    this._prevDepthData = null;
    this._temporalSmoothing = this.shaderOpts.temporalSmoothing !== undefined
      ? this.shaderOpts.temporalSmoothing
      : 0.85;

    this._initialized = false;
  }

  init() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      premultipliedAlpha: false,
      antialias: false,
    });

    if (!gl) {
      throw new Error('[planespace] WebGL2 not available');
    }

    this._gl = gl;

    const fragSrc = (this.shaderOpts.fragment) || FRAG_SRC;
    this._program = this._compile(VERT_SRC, fragSrc);
    gl.useProgram(this._program);

    // Fullscreen quad
    const positions = new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
      -1,  1,
       1, -1,
       1,  1,
    ]);

    this._vao = gl.createVertexArray();
    gl.bindVertexArray(this._vao);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    const posLoc = gl.getAttribLocation(this._program, 'a_position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    // Texture slots
    this._textures.scene = this._createTexture(0);
    this._textures.depth = this._createTexture(1);

    // Cache uniform locations
    this._uniforms = {
      T_scene: gl.getUniformLocation(this._program, 'T_scene'),
      T_depth: gl.getUniformLocation(this._program, 'T_depth'),
      viewerAngle: gl.getUniformLocation(this._program, 'viewerAngle'),
      warpStrength: gl.getUniformLocation(this._program, 'warpStrength'),
      resolution: gl.getUniformLocation(this._program, 'resolution'),
      edgeClamping: gl.getUniformLocation(this._program, 'edgeClamping'),
      chromaticOffset: gl.getUniformLocation(this._program, 'chromaticOffset'),
      chromaticStrength: gl.getUniformLocation(this._program, 'chromaticStrength'),
      vignetteStrength: gl.getUniformLocation(this._program, 'vignetteStrength'),
    };

    // Set static uniforms
    gl.uniform1i(this._uniforms.T_scene, 0);
    gl.uniform1i(this._uniforms.T_depth, 1);
    gl.uniform1f(this._uniforms.warpStrength, this.shaderOpts.warpStrength || 0.015);
    gl.uniform1i(this._uniforms.edgeClamping, this.shaderOpts.edgeClamping !== false ? 1 : 0);
    gl.uniform1i(this._uniforms.chromaticOffset, this.shaderOpts.chromaticOffset ? 1 : 0);
    gl.uniform1f(this._uniforms.chromaticStrength, this.shaderOpts.chromaticStrength || 0.002);
    gl.uniform1f(this._uniforms.vignetteStrength, this.shaderOpts.vignetteStrength !== undefined ? this.shaderOpts.vignetteStrength : 0.3);

    this._initialized = true;
  }

  _compile(vertSrc, fragSrc) {
    const gl = this._gl;

    const vert = this._compileShader(gl.VERTEX_SHADER, vertSrc);
    const frag = this._compileShader(gl.FRAGMENT_SHADER, fragSrc);

    const program = gl.createProgram();
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`[planespace] Shader link failed: ${gl.getProgramInfoLog(program)}`);
    }

    gl.deleteShader(vert);
    gl.deleteShader(frag);

    return program;
  }

  _compileShader(type, src) {
    const gl = this._gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`[planespace] Shader compile error: ${info}`);
    }

    return shader;
  }

  _createTexture(unit) {
    const gl = this._gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }

  /**
   * Upload scene image (ImageBitmap, HTMLCanvasElement, ImageData, etc.)
   */
  uploadScene(source) {
    const gl = this._gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._textures.scene);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  /**
   * Upload depth map (Float32Array, width, height)
   * Applies temporal smoothing if enabled.
   */
  uploadDepth({ data, width, height }) {
    const gl = this._gl;

    let finalData = data;

    // Temporal smoothing: lerp between previous and current depth
    if (this._temporalSmoothing > 0 && this._prevDepthData &&
        this._prevDepthData.length === data.length) {
      const alpha = 1 - this._temporalSmoothing;
      finalData = new Float32Array(data.length);
      for (let i = 0; i < data.length; i++) {
        finalData[i] = this._prevDepthData[i] * this._temporalSmoothing + data[i] * alpha;
      }
    }

    this._prevDepthData = finalData;

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._textures.depth);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, finalData);
  }

  /**
   * Render one frame with the given viewer angle.
   */
  render(viewerX, viewerY) {
    const gl = this._gl;
    const w = this.canvas.width;
    const h = this.canvas.height;

    gl.viewport(0, 0, w, h);
    gl.useProgram(this._program);
    gl.bindVertexArray(this._vao);

    gl.uniform2f(this._uniforms.viewerAngle, viewerX, viewerY);
    gl.uniform2f(this._uniforms.resolution, w, h);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  destroy() {
    const gl = this._gl;
    if (!gl) return;
    gl.deleteProgram(this._program);
    gl.deleteTexture(this._textures.scene);
    gl.deleteTexture(this._textures.depth);
    gl.deleteVertexArray(this._vao);
    this._initialized = false;
  }

  static isSupported() {
    try {
      const c = document.createElement('canvas');
      return !!c.getContext('webgl2');
    } catch {
      return false;
    }
  }
}
