const CONSTANTS = {
  shapes: {
    quad: new Float32Array([
      -1,-1,
      1,-1,
      1,1,
      -1,-1,
      1,1,
      -1,1
    ]),
    triangle: new Float32Array([
      0,1,
      -.5,-1.,
      .5,-1.
    ])
  },

  defaultStorageFlags : GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,

  workgroupSize: 8,

  blend:{
    color: {
      srcFactor: 'src-alpha',
      dstFactor: 'one-minus-src-alpha',
      operation: 'add',
    },
    alpha: {
      srcFactor: 'one',
      dstFactor: 'one-minus-src-alpha',
      operation: 'add',
    }
  },

  vertex:`@vertex 
fn vs( @location(0) input : vec2f ) ->  @builtin(position) vec4f {
  return vec4f( input, 0., 1.); 
}

`, 

  //textureFormat:'bgra8unorm',
  textureFormat:navigator.gpu.getPreferredCanvasFormat(),
  storageTextureFormat:'rgba16float'


}

// to "fix" inconsistencies with device.writeBuffer
const mult = navigator.userAgent.indexOf('Chrome') === -1 ? 4 : 1

//let backTexture = null
const gulls = {
  isBroken:false,
  constants:CONSTANTS,

  async getDevice() {
    const adapter = await navigator.gpu?.requestAdapter()
    const device = await adapter?.requestDevice()

    if (!device) {
      console.error('need a browser that supports WebGPU')
      return
    }

    // XXX this currently yields way too many errors when
    // shaders with errors attempt to run and floods the console,
    // so they're commented out until fixed
    device.addEventListener("uncapturederror", event => {
      //console.error("A WebGPU error was not captured:", event.error)
      //throw event.error
      gulls.isBroken = true
    })


    return device
  },
  
  setupCanvas( device=null, canvas=null ) {
    if( canvas === null ) canvas = document.getElementsByTagName('canvas')[0]
    if( canvas === null ) {
      console.error('could not find canvas to initialize gulls')
      return
    }

    const context = canvas.getContext('webgpu'),
          format  = navigator.gpu.getPreferredCanvasFormat()

    context.configure({
      device,
      format,
      alphaMode:'premultiplied',
      usage:GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING
    })

    const devicePixelRatio = window.devicePixelRatio || 1
    gulls.width  = canvas.width  = Math.floor(window.innerWidth ) // * devicePixelRatio)
    gulls.height = canvas.height = Math.floor(window.innerHeight) //* devicePixelRatio)
    canvas.style.height = gulls.height + 'px'
    canvas.style.width  = gulls.width  + 'px'

    //backTexture = gulls.createTexture( device, format, canvas )

    return [ canvas, context, format ]
  },

  async import( file ) {
    const f = await fetch( file )
    const txt = await f.text()

    return txt
  },

  createTexture( device, format, canvas, usage=null ) {
    //console.log( 'texture:', usage )
    const tex = device.createTexture({
      size: Array.isArray( canvas ) ? canvas : [canvas.width, canvas.height],
      format,
      usage: usage===null ? GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT  : usage
    })

    return tex
  },

  createVertexBuffer2D( device, vertices, stride=8, label='vertex buffer' ) {
    const buffer = device.createBuffer({
      label,
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    })
    device.queue.writeBuffer( buffer, 0, vertices )
    
    // would need to change arrayStride to 12 for 3D vertices
    const vertexBufferLayout = {
      arrayStride: stride,
      attributes: [{
        format: "float32x2",
        offset: 0,
        shaderLocation: 0, 
      }],
    }

    return [buffer, vertexBufferLayout]

  },

  createStorageBuffer( device=null, storage=null, label='storage', usage=CONSTANTS.defaultStorageFlags, offset=0 ) {
    const buffer = device.createBuffer({
      label,
      usage,
      size: storage.byteLength,
    })

    device.queue.writeBuffer( buffer, offset, storage )

    return buffer
  },

  createUniformBuffer( device, values, label='seagull uniforms' ) {
    const arr = new Float32Array(values)

    const buff = device.createBuffer({
      label: label + (Math.round( Math.random() * 100000 )),
      size:  arr.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    })

    device.queue.writeBuffer( buff, 0, arr )

    return buff
  },

  
  createSimulationPipeline( device, pingponglayout, code ) {
    const layout = device.createPipelineLayout({
      label:'cell pipeline layout',
      bindGroupLayouts: Array.isArray( pingponglayout ) ? pingponglayout : [ pingponglayout ]
    })

    const module = device.createShaderModule({
      label: 'sim',
      code
    })

    const p = device.createComputePipeline({
      label: 'sim',
      layout,
      compute: {
        module,
        entryPoint: 'cs'
      }
    })

    return p
  },

  createLayoutEntry( data, count=0, type='render', readwrite='read-only-storage' ) {
    let entry
    // XXX this needs to be fixed for vertex-based simulations
    // comment out | GPUShaderStage.VERTEX for readwrite in compute
    const visibility = type === 'render'
      ? data.type !== 'storageTexture' && data.type !== 'texture' 
        ? GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX  
        : GPUShaderStage.FRAGMENT 
      : GPUShaderStage.COMPUTE

    switch( data.type ) {
      case 'uniform':
        entry = {
          binding: count,
          visibility,
          buffer: { type:'uniform' }
        }
        break
      case 'texture': case 'feedback':
        entry = {
          binding: count,
          visibility,
          texture: {}
        }
        break
      case 'storageTexture':
        entry = {
          binding: count,
          visibility,
          storageTexture:{
            format:CONSTANTS.storageTextureFormat
          }
        }
        break
      case 'sampler':
        entry = {
          binding: count,
          visibility,
          sampler: {}
        }
        break
      case 'buffer':
        // make sure we don't specify buffers as read/write for fragment
        // and vertex shaders
        const __type = type === 'render' ? 'read-only-storage' : readwrite 
        
        entry = {
          visibility,
          binding: count,
          buffer:  { type: __type } 
        }
        break
    }

    return entry
  },

  // how to handle feedback/back buffer?
  createBindGroupLayout( device, data, type='render', label='render layout' ) {
    let count = 0
    const entries = []

    if( data !== null ) {
      for( let d of data ) {
        if( d.type === 'video' ) continue

        if( d.type === 'pingpong' ) {
          if( d.b.type === 'texture' ) d.b.type = 'storageTexture'
          entries.push( gulls.createLayoutEntry( d.a, count++, type ) )
          entries.push( gulls.createLayoutEntry( d.b, count++, type, 'storage' ) )
        }else{
          // TODO is it safe to assume that a buffer not included in a pingpong will always
          // be read/write as part of a compute shader?
          const mode = type === 'compute' ? 'storage' : 'read-only-storage'
          entries.push( gulls.createLayoutEntry( d, count++, type, mode ) )
        }
      }
    }

    const bindGroupLayout = device.createBindGroupLayout({
      label,
      entries
    })

    return bindGroupLayout
  },

  createRenderBindGroupEntry( data, count ) {
    let entry
    switch( data.type ) {
      case 'uniform':
        entry = {
          binding:  count,
          resource: { buffer: data },
        }
        break
      case 'texture': case 'storageTexture':
        entry = {
          binding:  count,
          resource: data.createView() 
        }
        break
      case 'storageTexture':
        entry = {
          binding:  count,
          resource: data.createView({ format:CONSTANTS.storageTextureFormat }) 
        }
        break;
      /*case 'feedback':
        entry = {
          binding:  count,
          resource: backTexture.createView() 
        }
        break*/
      case 'sampler':
        entry = {
          binding: count,
          resource: data.sampler,
        }
        break
      case 'buffer':
        entry = {
          binding: count,
          resource:  { buffer:data.buffer } 
        }
        break
    }
    entry.type = data.type

    return entry
  },

  createBindGroups( device, layout, data, pingpong=false, type='render' ) {
    const entriesA = [],
          entriesB = []

    pingpong = !!pingpong

    let count = 0 

    if( data !== null ) {
      for( let d of data ) {
        if( d.type === 'video' ) continue
        if( d.type !== 'pingpong' ) {
          const entry = gulls.createRenderBindGroupEntry( d, count++ )
          entriesA.push( entry )
          if( pingpong ) entriesB.push( entry )
        }else{
          const a = gulls.createRenderBindGroupEntry( d.a, count ),
                b = gulls.createRenderBindGroupEntry( d.b, count + 1 ),
                a1= gulls.createRenderBindGroupEntry( d.a, count + 1 ),
                b1= gulls.createRenderBindGroupEntry( d.b, count )

          entriesA.push( a, b  )
          entriesB.push( a1,b1 )

          count += 2
        }
      }
    }
    
    const bindGroups = [
      device.createBindGroup({
        label:`${name} a`,
        layout,
        entries:entriesA
      })
    ]
    
    // we only need a second bind group if
    // we are pingponging textures / buffers
    if( pingpong === true ) {
      bindGroups.push(
        device.createBindGroup({
          label:`${name} b`,
          layout,
          entries: entriesB      
        })
      )
    }

    return bindGroups
  },

  async createRenderPipeline( device, code, presentationFormat, vertexBufferLayout, bindGroupLayout, data, shouldBlend=false ) {
    const module = device.createShaderModule({
      label: 'main render',
      code
    })

    const info = await module.getCompilationInfo()
    let shouldHalt = false
    if( info.messages.length ) {
      info.messages.forEach( m => {
        if( m.type === 'error' ) {
          shouldHalt = true
        }
      })
    }

    if( shouldHalt ) return info.messages


    const bindGroupLayouts = [ bindGroupLayout ]
    const videos = data !== null ? data.filter( d => d.type === 'video' ) : null
    const hasExternalTexture = videos !== null && videos.length > 0 

    if( navigator.userAgent.indexOf('Firefox') === -1 && hasExternalTexture ) {
      const externalEntry = {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        externalTexture:{}
      }

      const externalLayout = device.createBindGroupLayout({
        label:'external layout',
        entries:[ externalEntry ]
      })

      bindGroupLayouts.push( externalLayout )
    }

    const pipelineLayout = device.createPipelineLayout({
      label: "render pipeline layout",
      bindGroupLayouts
    })

    const pipeline = device.createRenderPipeline({
      label: "render pipeline",
      layout:pipelineLayout,
      vertex: {
        module,
        entryPoint: "vs",
        buffers: [vertexBufferLayout]
      },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [{
          format: presentationFormat,
          blend: shouldBlend ? CONSTANTS.blend : undefined
        }]
      }
    });

    return pipeline
  },

  async createRenderStage( device, props, presentationFormat ) {
    const shader = props.shader,
          data   = props.data,
          blend  = props.blend

    const vertices = props.vertices
    const [vertexBuffer, vertexBufferLayout] = gulls.createVertexBuffer2D( device, vertices )

    const renderLayout = gulls.createBindGroupLayout( device, props.data )

    // check all entries to see if any need to pingpong
    let shouldPingPong = false
    if( props.data !== null )
      shouldPingPong = props.data.reduce( (a,v) => a + (v.type === 'pingpong' ? 1 : 0), 0 )

    const bindGroups = gulls.createBindGroups( device, renderLayout, props.data, shouldPingPong )

    let textures = []
    if( props.data !== null )
      textures   = props.data.filter( d => d.type === 'texture' )

    const pipeline   = await gulls.createRenderPipeline( 
      device, 
      shader, 
      presentationFormat, 
      vertexBufferLayout, 
      renderLayout, 
      data, 
      blend 
    )

    if( Array.isArray( pipeline ) ) {
      throw( pipeline[0] )
    }

    return [ pipeline, bindGroups, vertexBuffer ]
  },

  createSimulationStage( device, computeShader, data ) {
    let shouldPingPong = false
    if( data !== null )
      shouldPingPong = !!data.reduce( (a,v) => a + (v.type === 'pingpong' ? 1 : 0), 0 )

    let simLayout     = gulls.createBindGroupLayout( device, data, 'compute', 'compute layout' ) 
    const simBindGroups = gulls.createBindGroups( device, simLayout, data, shouldPingPong, 'compute' ) 

    const videos = data !== null ? data.filter( d => d.type === 'video' ) : null
    const hasExternalTexture = videos !== null && videos.length > 0 

    if( navigator.userAgent.indexOf('Firefox') === -1 && hasExternalTexture ) {
      const externalEntry = {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        externalTexture:{}
      }

      const externalLayout = device.createBindGroupLayout({
        label:'external layout',
        entries:[ externalEntry ]
      })

      simLayout = [ simLayout, externalLayout ]
    }

   
    const simPipeline   = gulls.createSimulationPipeline( device, simLayout, computeShader )

    return [ simPipeline, simBindGroups ]
  },

  pingpong( encoder, pass ) {
    const videos   = pass.data !== null 
      ? pass.data.filter( d => d.type === 'video' ) 
      : null

    const useVideo = navigator.userAgent.indexOf('Firefox') === -1 
      && videos !== null 
      && videos.length > 0
      
    let externalTextureBindGroup = null
    if( useVideo ) {
      const externalLayout = pass.device.createBindGroupLayout({
        label:'external layout',
        entries:[{
          binding:0,
          visibility: GPUShaderStage.COMPUTE,
          externalTexture: {}
        }]
      })
      
      externalTextureBindGroup = gulls.getExternalVideo( pass, externalLayout, videos )
    }

    for( let i = 0; i < pass.times; i++ ) {
      const computePass = encoder.beginComputePass()
      const bindGroupIndex = pass.shouldPingPong === true ? pass.step++ % 2 : 0
      
      computePass.setPipeline( pass.pipeline )
      computePass.setBindGroup( 0, pass.bindGroups[ bindGroupIndex ] ) 
      if( useVideo ) {
        computePass.setBindGroup( 1, externalTextureBindGroup )
      }   
      
      if( Array.isArray( pass.dispatchCount ) ) {
        computePass.dispatchWorkgroups( pass.dispatchCount[0], pass.dispatchCount[1], pass.dispatchCount[2] )
      }else{
        computePass.dispatchWorkgroups( pass.dispatchCount,pass.dispatchCount,1 )
      }

      computePass.end()
    }
    
    return pass.step
  },

  // XXX is there some way to only do this once per pass
  // if the video is being used in both compute and 
  // render shaders? is it even expensive to do this twice?
  getExternalVideo( passDesc, externalLayout, videos ) {
    let externalTextureBindGroup = null

    try {
      const resource = passDesc.device.importExternalTexture({
        source:videos[0].src//passDesc.textures[0]
      })

      externalTextureBindGroup = passDesc.device.createBindGroup({
        layout: externalLayout,
        entries: [{
          binding: 0,
          resource//vec4f( out, 1. );
        }]
      }) 
    }catch( e ) {
      console.log( e )
    }

    return externalTextureBindGroup
  },

  render( encoder, passDesc ) {
    const shouldCopy = passDesc.context !== null || passDesc.copy !== nulll

    const renderPassDescriptor = {
      label: 'render',
      colorAttachments: [{
        view: passDesc.view,
        clearValue: passDesc.clearValue,
        loadOp:  'clear',
        storeOp: 'store',
      }]
    }
    
    const videos   = passDesc.data !== null 
            ? passDesc.data.filter( d => d.type === 'video' ) 
            : null

    const useVideo = navigator.userAgent.indexOf('Firefox') === -1 
            && videos !== null 
            && videos.length > 0

    let externalTextureBindGroup = null
    if( useVideo ) {
      const externalLayout = passDesc.device.createBindGroupLayout({
        label:'external layout',
        entries:[{
          binding:0,
          visibility: GPUShaderStage.FRAGMENT,
          externalTexture: {}
        }]
      })
      
      externalTextureBindGroup = gulls.getExternalVideo( passDesc, externalLayout, videos )
    }
        // in case we want a backbuffer etc. eventually this should probably be
    // replaced with a more generic post-processing setup
    let swapChainTexture = null
    if( shouldCopy ) {
      swapChainTexture = passDesc.context.getCurrentTexture()
      renderPassDescriptor.colorAttachments[0].view = swapChainTexture.createView()
    }

    const pass = encoder.beginRenderPass( renderPassDescriptor )
    pass.setPipeline( passDesc.renderPipeline )

    pass.setVertexBuffer( 0, passDesc.vertexBuffer )

    // only switch bindgroups if pingpong is needed
    const bindGroupIndex = passDesc.shouldPingPong === true ? passDesc.step++ % 2 : 0

    pass.setBindGroup( 0, passDesc.renderBindGroups[ bindGroupIndex ] )

    if( useVideo ) { 
      pass.setBindGroup( 1, externalTextureBindGroup ) 
    }
    
    // TODO: generalize to 3d
    pass.draw(passDesc.vertices.length/2, passDesc.count )  
    pass.end()

    
    if( passDesc.copy !== null ) {
      encoder.copyTextureToTexture(
        { texture: swapChainTexture },
        { texture: passDesc.copy },
        [ gulls.width, gulls.height ]
      )

    }

    return passDesc.step
  },

  async init( ) {
    const device = await gulls.getDevice()

    const [canvas, context, presentationFormat] = gulls.setupCanvas( device )
    const view = context.getCurrentTexture().createView()

    const instance = Object.create( gulls.proto )
    Object.assign( instance, { 
      canvas, 
      context, 
      presentationFormat, 
      view, 
      device, 
      computeStep:0,
      renderStep: 0,
      frame:      0,
      times:      1,
      clearColor: [0,0,0,1],
      shouldUseBackBuffer:true,
      width:  gulls.width,
      height: gulls.height,
      __blend: false,
      __computeStages: [],
      __textures:null
    })

    
    return instance
  },

  proto: {
    buffer( v, label='', type='float' ) {
      const usage = v.usage !== undefined ? v.usage : CONSTANTS.defaultStorageFlags
      const __buffer = gulls.createStorageBuffer( this.device, v, label, usage )

      const buffer = { type:'buffer', buffer:__buffer }
      buffer.clear = ()=> {
        v.fill(0)
        this.device.queue.writeBuffer(
          //__buffer, 0, v, 0, v.length * mult 
          __buffer, 0, v 
        )
      }

      buffer.write = ( buffer, readStart=0, writeStart=0, length=-1 ) => {
        this.device.queue.writeBuffer(
          __buffer, 
          readStart, 
          __buffer, 
          writeStart 
          //length === -1 ? __buffer.length * mult : length
        )
      }

      buffer.read = async ( size=null, offset=0 ) => {
        const read = __buffer
        if( size === null ) size = read.size

        await read.mapAsync(
          GPUMapMode.READ,
          offset*4,
          size*4
        )
  
        let data = null
        try{
          const copyArrayBuffer = read.getMappedRange( 0, size*4 )
          data = copyArrayBuffer.slice( 0 )
        }catch(e) {
          read.unmap()
          console.warn( 'error reading buffer with size:', size )
        }
        read.unmap()

        data = new Float32Array( data )

        //console.log( 'returned length:', data.length )
        return data 
      }

      buffer.loopRead = async ( size = null, offset = 0, cb ) => {
        const __read = async function() {
          const read = __buffer
          if( size === null ) size = read.size

          await read.mapAsync(
            GPUMapMode.READ,
            offset*4,
            size*4
          )
          
          cb( read )

          __read()
        }
        __read()
      }

      buffer.convert = function( size ) {
        let data = null
        try{
          const copyArrayBuffer = __buffer.getMappedRange( 0, size*4 )
          data = copyArrayBuffer.slice( 0 )
        }catch(e) {
          __buffer.unmap()
          console.warn( 'error reading buffer with size:', size )
        }
        __buffer.unmap()

        data = new Float32Array( data )

        return data
      }

      return buffer
    },

    uniform( __value, type='float' ) {
      const value = Array.isArray( __value ) ? __value : [ __value ]
      const buffer = gulls.createUniformBuffer( this.device, value, type )
      const storage = new Float32Array( value )
      const device = this.device

      if( Array.isArray( __value ) ) {
        buffer.value = {}
        for( let i = 0; i < value.length; i++ ) {
          Object.defineProperty( buffer.value, i, {
            set(v) {
              storage[ i ] = v
              //device.queue.writeBuffer( buffer, i*4, storage, i*4, mult )
              device.queue.writeBuffer( buffer, i*4, storage, i*4 )
            },
            get() {
              return storage[ i ]
            }
          })
        }
        Object.defineProperty( buffer, 'value', {
          set(v) {
            storage.set( v )
            // apparently docs are wrong, all arguments are actually in bytes wtf
            // https://developer.mozilla.org/en-US/docs/Web/API/GPUQueue/writeBuffer
            device.queue.writeBuffer( buffer, 0, storage, 0 )
            //device.queue.writeBuffer( buffer, 0, storage, 0, v.length * mult )
          },
          get() {
            return storage
          }
        })
      }else{
        Object.defineProperty( buffer, 'value', {
          set( v ) {
            storage[ 0 ] = v
            device.queue.writeBuffer( buffer, 0, storage, 0 )
            //device.queue.writeBuffer( buffer, 0, storage, 0, mult )
          },
          get() {
            return storage[0]
          }
        })
      }

      buffer.type = 'uniform'

      return buffer
    },

    sampler( args=null ) {
      const defaults = {
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'repeat',
        addressModeV: 'repeat',
      }
      if( args !== null ) Object.assign( defaults, args )

      const sampler = { 
        type:'sampler',
        sampler : this.device.createSampler( defaults )
      }

      return sampler
    },

    feedback() {
      const feedback = { 
        type:'feedback'
      }

      return feedback
    },

    video( src ) {
      return { type:'video', src }
    },

    pingpong( a,b ) {
      if( a.format !== b.format ) {
        console.error( `gulls error: In order to pingpong textures the read texture must be specified as type rgba16float (e.g. sg.texture( tex, 'rgba16float' ); storageTextures use this format automatically`)
      }
      return { type:'pingpong', a, b }
    },

    storageTexture( tex, format=null ) {
      if( format === null ) format = CONSTANTS.storageTextureFormat
      
      const texture = this.texture( 
        tex, 
        format, 
        GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING, 
        'storageTexture' 
      )

      return texture
    },

    texture( tex, format=null, usage=GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.STORAGE_BINDING, type='texture' ) {
      if( format === null ) format = CONSTANTS.textureFormat

      if( format === CONSTANTS.textureFormat ) usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT 

      const texture = gulls.createTexture( this.device, format, [this.width, this.height], usage )
      texture.type = type 
      texture.src = tex
      
      const numElements = this.width * this.height
      const numChannels = tex.byteLength / numElements
      const bytesPerElement = numChannels //* tex.BYTES_PER_ELEMENT
      //console.log( numElements, numChannels, bytesPerElement )
      
      
      this.device.queue.writeTexture(
        { texture }, 
        tex,
        { bytesPerRow: this.width * bytesPerElement, rowsPerImage: this.height }, 
        { width:this.width, height:this.height }
      )
      /*this.device.queue.copyExternalImageToTexture(
        { source:texture, flipY: true },
        { texture },
        { width: this.width, height: this.height },
      )*/

      return texture
    },

    
    compute( args ) {
      const pass = {
        type:     'compute',
        device:   this.device,
        data:     null, 
        shader:   args.shader,
        dispatchCount: [1,1,1],
        times:    1,
        step:     0
      }

      Object.assign( pass, args )

      const [ simPipeline, simBindGroups ] = gulls.createSimulationStage( 
        pass.device,
        pass.shader, 
        pass.data 
      )

      pass.pipeline   = simPipeline
      pass.bindGroups = simBindGroups

      if( pass.data !== null ) {
        pass.shouldPingPong = !!pass.data.reduce( (a,v) => a + (v.type === 'pingpong' ? 1 : 0), 0 )
      }else{
        pass.shouldPingPong = false
      }

      return pass 
    },


    async render( args ) {
      if( args.view !== undefined ) args.view = args.view.createView()
      const pass = {
        type:   'render',
        device: this.device,
        presentationFormat: this.presentationFormat,
        clearColor: this.clearColor,
        view: args.view || this.view,
        step: 0,
        canvas: this.canvas,
        context: this.context,
        data:null,
        shader:null,
        count:1,
        copy: args.copy || null
      }

      Object.assign( pass, args )
     
      if( pass.vertices === undefined ) pass.vertices = CONSTANTS.shapes.quad

      const [renderPipeline, renderBindGroups, vertexBuffer] = await gulls.createRenderStage(
        this.device,
        pass,
        this.presentationFormat
      )

      pass.renderPipeline = renderPipeline
      pass.renderBindGroups = renderBindGroups
      pass.vertexBuffer = vertexBuffer

      if( pass.data !== null ) {
        pass.shouldPingPong = !!pass.data.reduce( (a,v) => a + (v.type === 'pingpong' ? 1 : 0), 0 )
      }else{
        pass.shouldPingPong = false
      }
      
      return pass
    },

    async run( ...passes ) {
      await this.once( ...passes ) 
      //if( !gulls.isBroken )
      window.requestAnimationFrame( async ()=> { await this.run( ...passes ) })
    },

    copy( src, dst, size=null, offset=0 ) {
      if( size === null ) size = src.buffer.size
      return { src:src.buffer, dst:dst.buffer, size, offset, type:'copy' }
    },

    async once( ...passes ) {
      const encoder = this.device.createCommandEncoder({ label: 'gulls encoder' })
      for( let pass of passes ) {
        try {
          if( typeof pass.onframe === 'function' ) await pass.onframe()
        } catch(e) {
          console.warn('caught error with onframe for ' + pass.type + ' pass.', e ) 
        }

        if( pass.type === 'render' ) {
          pass.step = await gulls.render( encoder, pass )
        }else if( pass.type === 'compute' ) {
          pass.step = gulls.pingpong( encoder, pass )
        }else if( pass.type === 'copy' ) {
          await encoder.copyBufferToBuffer(
            pass.src,    /* source buffer */
            pass.offset, /* source offset */
            pass.dst,    /* destination buffer */
            pass.offset, /* destination offset */
            pass.size    /* size */
          )
        }

        try {
          if( typeof pass.onframeend === 'function' ) await pass.onframeend()
        } catch(e) {
          console.warn('caught error with onframeend for ' + pass.type + ' pass.', e ) 
        }
      }

      this.device.queue.submit([ encoder.finish() ])
    }

  }
}

export default gulls
