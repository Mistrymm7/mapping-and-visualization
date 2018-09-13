// reference https://github.com/Esri/jsapi-resources/tree/master/4.x/typescript/demo

import EsriMap = require('esri/Map');
import SceneView = require('esri/views/SceneView');
import externalRenderers = require('esri/views/3d/externalRenderers');
import SpatialReference = require('esri/geometry/SpatialReference');
import esriRequest = require('esri/request');

import * as THREE from 'three';
// import { NVisCanvasSandbox } from './NVisCanvasSandbox/NVisCanvasSandbox';

const map = new EsriMap({
    // https://totalapis.github.io/api-reference/esri-Map.html#basemap
    basemap: "dark-gray-vector" // topo, dark-gray-vector, streets, streets-night-vector
});

const view = new SceneView({
    container: "viewDiv",
    map: map,
    viewingMode: "global",
    camera: {
        position: {
            x: -9932671,
            y: 2380007,
            z: 1687219,
            spatialReference: { wkid: 102100 }
        },
        heading: 0,
        tilt: 35
    },
});
view.environment.lighting.cameraTrackingEnabled = false;

// NVisCanvasSandbox.StartApp(map, view);

var issExternalRenderer = {
    // tslint:disable-next-line:no-any
    renderer: {},     // three.js renderer
    camera: {},       // three.js camera
    scene: {},        // three.js scene

    ambient: {},      // three.js ambient light source
    sun: {},          // three.js sun light source

    iss: {},                                                          // ISS model
    issScale: 40000,                                                    // scale for the iss model
    issMaterial: new THREE.MeshLambertMaterial({ color: 0xe03110 }),    // material for the ISS model

    cameraPositionInitialized: false, // we focus the view on the ISS once we receive our first data point
    positionHistory: {},              // all ISS positions received so far

    markerMaterial: {},    // material for the markers left by the ISS
    markerGeometry: {},    // geometry for the markers left by the ISS

    /**
     * Setup function, called once by the ArcGIS JS API.
     */
    setup: function (ctx: any) {

        // initialize the three.js renderer
        //////////////////////////////////////////////////////////////////////////////////////
        this.renderer = new THREE.WebGLRenderer({ context: ctx.gl, premultipliedAlpha: false });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setViewport(0, 0, view.width, view.height);

        // prevent three.js from clearing the buffers provided by the ArcGIS JS API.
        this.renderer.autoClearDepth = false;
        this.renderer.autoClearStencil = false;
        this.renderer.autoClearColor = false;

        // The ArcGIS JS API renders to custom offscreen buffers, and not to the default framebuffers.
        // We have to inject this bit of code into the three.js runtime in order for it to bind those
        // buffers instead of the default ones.
        var originalSetRenderTarget = this.renderer.setRenderTarget.bind(this.renderer);
        this.renderer.setRenderTarget = function (target: any) {
            originalSetRenderTarget(target);
            if (target == null) {
                ctx.bindRenderTarget();
            }
        }

        // setup the three.js scene
        ///////////////////////////////////////////////////////////////////////////////////////

        this.scene = new THREE.Scene();

        // setup the camera
        this.camera = new THREE.PerspectiveCamera();

        // setup scene lighting
        this.ambient = new THREE.AmbientLight(0xffffff, 0.5);
        this.scene.add(this.ambient);
        this.sun = new THREE.DirectionalLight(0xffffff, 0.5);
        this.scene.add(this.sun);

        // setup markers
        this.markerGeometry = new THREE.SphereBufferGeometry(12 * 1000, 16, 16);
        this.markerMaterial = new THREE.MeshBasicMaterial({ color: 0xe03110, transparent: true, opacity: 0.75 });

        // load ISS mesh
        var issMeshUrl = "data/iss.obj";
        var loader = new THREE.OBJLoader(THREE.DefaultLoadingManager);
        loader.load(issMeshUrl, function (object3d: any) {
            console.log("ISS mesh loaded.");
            this.iss = object3d;

            // apply ISS material to all nodes in the geometry
            this.iss.traverse(function (child: any) {
                if (child instanceof THREE.Mesh) {
                    child.material = this.issMaterial;
                }
            }.bind(this));

            // set the specified scale for the model
            this.iss.scale.set(this.issScale, this.issScale, this.issScale);

            // add the model
            this.scene.add(this.iss);
        }.bind(this), undefined, function (error) {
            console.error("Error loading ISS mesh. ", error);
        });

        // create the horizon model
        var mat = new THREE.MeshBasicMaterial({ color: 0x2194ce });
        mat.transparent = true;
        mat.opacity = 0.5;
        this.region = new THREE.Mesh(
            new THREE.TorusBufferGeometry(2294 * 1000, 100 * 1000, 16, 64),
            mat
        );
        this.scene.add(this.region);


        // start querying the ISS position
        this.queryISSPosition();

        // cleanup after ourselfs
        ctx.resetWebGLState();
    },

    render: function (context: any) {

        // update camera parameters
        ///////////////////////////////////////////////////////////////////////////////////
        var cam = context.camera;

        this.camera.position.set(cam.eye[0], cam.eye[1], cam.eye[2]);
        this.camera.up.set(cam.up[0], cam.up[1], cam.up[2]);
        this.camera.lookAt(new THREE.Vector3(cam.center[0], cam.center[1], cam.center[2]));

        // Projection matrix can be copied directly
        this.camera.projectionMatrix.fromArray(cam.projectionMatrix);

        // update ISS and region position
        ///////////////////////////////////////////////////////////////////////////////////
        if (this.iss) {
            var posEst = this.computeISSPosition();

            var renderPos = [0, 0, 0];
            externalRenderers.toRenderCoordinates(view, posEst, 0, SpatialReference.WGS84, renderPos, 0, 1);
            this.iss.position.set(renderPos[0], renderPos[1], renderPos[2]);

            // for the region, we position a torus slightly under ground
            // the torus also needs to be rotated to lie flat on the ground
            posEst = [posEst[0], posEst[1], -450 * 1000];

            var transform = new THREE.Matrix4();
            transform.fromArray(externalRenderers.renderCoordinateTransformAt(view, posEst, SpatialReference.WGS84, new Array(16)));
            transform.decompose(this.region.position, this.region.quaternion, this.region.scale);

            // if we haven't initialized the view position yet, we do so now
            if (this.positionHistory.length > 0 && !this.cameraPositionInitialized) {
                this.cameraPositionInitialized = true;
                view.goTo({
                    target: [posEst[0], posEst[1]],
                    zoom: 5,
                });
            }
        }

        // update lighting
        /////////////////////////////////////////////////////////////////////////////////////////////////////
        // view.environment.lighting.date = Date.now();

        var l = context.sunLight;
        this.sun.position.set(
            l.direction[0],
            l.direction[1],
            l.direction[2]
        );
        this.sun.intensity = l.diffuse.intensity;
        this.sun.color = new THREE.Color(l.diffuse.color[0], l.diffuse.color[1], l.diffuse.color[2]);

        this.ambient.intensity = l.ambient.intensity;
        this.ambient.color = new THREE.Color(l.ambient.color[0], l.ambient.color[1], l.ambient.color[2]);

        // draw the scene
        /////////////////////////////////////////////////////////////////////////////////////////////////////
        this.renderer.resetGLState();
        this.renderer.render(this.scene, this.camera);

        // as we want to smoothly animate the ISS movement, immediately request a re-render
        externalRenderers.requestRender(view);

        // cleanup
        context.resetWebGLState();
    },

    lastPosition: {},
    lastTime: {},

    /**
     * Computes an estimate for the position of the ISS based on the current time.
     */
    computeISSPosition: function () {
        if (this.positionHistory.length == 0) { return [0, 0, 0]; }

        if (this.positionHistory.length == 1) {
            var entry1 = this.positionHistory[this.positionHistory.length - 1];
            return entry1.pos;
        }

        var now = Date.now() / 1000;
        var entry1 = this.positionHistory[this.positionHistory.length - 1];

        // initialize the remembered ISS position
        if (!this.lastPosition) {
            this.lastPosition = entry1.pos;
            this.lastTime = entry1.time;
        }

        // compute a new estimated position
        var dt1 = now - entry1.time;
        var est1 = [
            entry1.pos[0] + dt1 * entry1.vel[0],
            entry1.pos[1] + dt1 * entry1.vel[1],
        ];

        // compute the delta of current and newly estimated position
        var dPos = [
            est1[0] - this.lastPosition[0],
            est1[1] - this.lastPosition[1],
        ];

        // compute required velocity to reach newly estimated position
        // but cap the actual velocity to 1.2 times the currently estimated ISS velocity
        var dt = now - this.lastTime;
        if (dt === 0) { dt = 1.0 / 1000; }

        var catchupVel = Math.sqrt(dPos[0] * dPos[0] + dPos[1] * dPos[1]) / dt;
        var maxVel = 1.2 * Math.sqrt(entry1.vel[0] * entry1.vel[0] + entry1.vel[1] * entry1.vel[1]);
        var factor = catchupVel <= maxVel ? 1.0 : maxVel / catchupVel;

        // move the current position towards the estimated position
        var newPos = [
            this.lastPosition[0] + dPos[0] * factor,
            this.lastPosition[1] + dPos[1] * factor,
            entry1.pos[2]
        ];

        this.lastPosition = newPos;
        this.lastTime = now;

        return newPos;
    },

    /**
     * This function starts a chain of calls querying the current ISS position from open-notify.org every 5 seconds.
     */
    queryISSPosition: function () {
        esriRequest("//open-notify-api.herokuapp.com/iss-now.json", {
            callbackParamName: "callback",
            responseType: "json"
        })
            .then(function (response: any) {
                var result = response.data;

                var vel = [0, 0];
                if (this.positionHistory.length > 0) {
                    var last = this.positionHistory[this.positionHistory.length - 1];
                    var deltaT = result.timestamp - last.time;
                    var vLon = (result.iss_position.longitude - last.pos[0]) / deltaT;
                    var vLat = (result.iss_position.latitude - last.pos[1]) / deltaT;
                    vel = [vLon, vLat];
                }

                this.positionHistory.push({
                    pos: [result.iss_position.longitude, result.iss_position.latitude, 400 * 1000],
                    time: result.timestamp,
                    vel: vel,
                });

                // create a new marker object from the second most recent position update
                if (this.positionHistory.length >= 2) {
                    var entry = this.positionHistory[this.positionHistory.length - 2];

                    var renderPos = [0, 0, 0];
                    externalRenderers.toRenderCoordinates(view, entry.pos, 0, SpatialReference.WGS84, renderPos, 0, 1);

                    var markerObject = new THREE.Mesh(this.markerGeometry, this.markerMaterial);
                    markerObject.position.set(renderPos[0], renderPos[1], renderPos[2]);
                    this.scene.add(markerObject);
                }
            }.bind(this))
            .always(function () {
                // request a new position update in 5 seconds
                setTimeout(this.queryISSPosition.bind(this), 5000);
            }.bind(this));
    }
}

// register the external renderer
externalRenderers.add(view, issExternalRenderer);

// require([
//     "esri/Map",
//     "",
//     "",
//     "",
//     "",
//     "dojo/domReady!"
//   ],
//   function(
//     Map,
//     SceneView,
//     externalRenderers,
//     SpatialReference,
//     esriRequest
//   ) {
