import { createPostprocessing } from '../../shared/postprocessing.js';

// One composite pass over the HDR frame: depth-sampled contact occlusion
// (grounds the flies, books and mug against the desk), a warm vignette, and
// the tone mapping/colour space the direct path used to do on the renderer.
export function createComposite(camera, settings) {
  return createPostprocessing(camera, {
    samples: settings.samples,
    fragmentShader: `
      uniform sampler2D beauty;uniform sampler2D depth;uniform vec2 size;uniform vec2 nearFar;uniform float aoRadiusScale;varying vec2 vUv;
      float distanceAt(vec2 p){float z=texture2D(depth,p).x;return nearFar.x*nearFar.y/(nearFar.y-z*(nearFar.y-nearFar.x));}
      void main(){
        vec3 color=texture2D(beauty,vUv).rgb;float center=distanceAt(vUv);float occlusion=0.;
        for(int i=0;i<${settings.aoSamples};i++) {
          float a=float(i)*2.399963;float radius=2.0+float(i)*${(12.0 / (settings.aoSamples - 1)).toFixed(8)};
          float sampleDepth=distanceAt(vUv+vec2(cos(a),sin(a))*radius*aoRadiusScale/size);
          float difference=center-sampleDepth;
          occlusion+=smoothstep(.008,.09,difference)*(1.-smoothstep(.15,.7,difference));
        }
        color*=1.-occlusion*${(0.024 * 12 / settings.aoSamples).toFixed(8)};
        // A soft bloom on the brightest things (the window, highlights): eight
        // ring taps, thresholded, added back at low weight.
        vec3 bloom=vec3(0.0);
        for(int i=0;i<8;i++) {
          float a=float(i)*0.785398;
          vec2 o=vec2(cos(a),sin(a))*6.0*aoRadiusScale/size;
          bloom+=max(texture2D(beauty,vUv+o).rgb-vec3(0.72),vec3(0.0));
        }
        color+=bloom*0.055;
        // Warm vignette: the room falls off into candle-light at the edges.
        vec2 v=(vUv-.5)*vec2(1.,.85);
        float vignette=dot(v,v);
        color*=1.-vignette*.18;
        color*=vec3(1.+.04*vignette, 1., 1.-.03*vignette);
        gl_FragColor=vec4(color,1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}
