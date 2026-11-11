// Liquid Glass behind an Electron window's page: a Node module (N-API) for
// Electron's main process, which Electron's own vibrancy can't do (its
// materials blur so heavily that nothing behind reads through).
//
//   glass.apply(win.getNativeWindowHandle(), { radius, dark, clear, tint, alpha, blur, material, blurRadius, pure, shoulders, lift })
//
// blurRadius (with blur): how strongly it blurs, past what the material does;
// pure: just that blur, without the material's grey tint.
// shoulders (with blur): shaped like the notch, for a window hanging from the
// top of the screen: concave shoulders this round at the top, under a band
// lift tall that sits above the screen; no shadow.
// dark: the dark look (the default), else the light one. clear: Liquid Glass's clear style (else regular). blur: a plain macOS blur
// (material: an NSVisualEffectMaterial number) instead of glass, always
// drawn as if the window were active. alpha: how strongly it's drawn; below
// 1 the sharp desktop shows through it, for a lighter, see-through look.
//   glass.remove(win.getNativeWindowHandle())
//   glass.preventActivation(win.getNativeWindowHandle())
//   glass.fade(win.getNativeWindowHandle(), alpha, seconds)
//   glass.allowAboveMenuBar(win.getNativeWindowHandle())
//   glass.shape(win.getNativeWindowHandle(), { left, right, bottom, shoulder, radius, lift, x1, y1, x2, y2 }, seconds)
//   glass.notches() → [{ x, y, width, height }], in Electron's screen coordinates
//   glass.panel(win.getNativeWindowHandle(), { show, x, y, width, height, radius,
//               fromX, fromY, fromWidth, fromHeight, fromRadius, seconds, x1, y1, x2, y2, material, dark })
//     A panel of macOS's own material (a menu's, by default) behind the page,
//     over the glass, at the rect (from the page's top left), growing from the
//     from-rect over seconds along the curve; show false shrinks it back into
//     the from-rect and takes it away. The page leaves a hole over it.
//
// Build: clang -bundle -undefined dynamic_lookup -fobjc-arc -framework AppKit
//        glass.m -o glass.node
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>

typedef struct napi_env__* napi_env;
typedef struct napi_value__* napi_value;
typedef struct napi_callback_info__* napi_callback_info;
typedef int napi_status;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);
extern napi_status napi_get_cb_info(napi_env, napi_callback_info, size_t*, napi_value*, napi_value*, void**);
extern napi_status napi_get_buffer_info(napi_env, napi_value, void**, size_t*);
extern napi_status napi_get_named_property(napi_env, napi_value, const char*, napi_value*);
extern napi_status napi_get_value_double(napi_env, napi_value, double*);
extern napi_status napi_get_value_bool(napi_env, napi_value, bool*);
extern napi_status napi_create_function(napi_env, const char*, size_t, napi_callback, void*, napi_value*);
extern napi_status napi_set_named_property(napi_env, napi_value, const char*, napi_value);
extern napi_status napi_get_boolean(napi_env, bool, napi_value*);
extern napi_status napi_create_array_with_length(napi_env, size_t, napi_value*);
extern napi_status napi_set_element(napi_env, napi_value, uint32_t, napi_value);
extern napi_status napi_create_object(napi_env, napi_value*);
extern napi_status napi_create_double(napi_env, double, napi_value*);

static NSString* const kId = @"muta-glass";

static NSView* viewFrom(napi_env env, napi_value buffer) {
  void* data = NULL;
  size_t length = 0;
  if (napi_get_buffer_info(env, buffer, &data, &length) != 0 || length < sizeof(void*)) return nil;
  return (__bridge NSView*)(*(void**)data);
}

static double number(napi_env env, napi_value options, const char* key, double fallback) {
  napi_value v;
  double d;
  if (napi_get_named_property(env, options, key, &v) == 0 && napi_get_value_double(env, v, &d) == 0) return d;
  return fallback;
}

static bool flag(napi_env env, napi_value options, const char* key, bool fallback) {
  napi_value v;
  bool b;
  if (napi_get_named_property(env, options, key, &v) == 0 && napi_get_value_bool(env, v, &b) == 0) return b;
  return fallback;
}

static NSView* existing(NSView* root) {
  for (NSView* v in root.subviews)
    if ([v.identifier isEqualToString:kId]) return v;
  return nil;
}

static napi_value result(napi_env env, bool ok) {
  napi_value r;
  napi_get_boolean(env, ok, &r);
  return r;
}

// The shape of a window hanging from the top of the screen like the notch:
// from the top of the screen, lift down the window (nothing above it, where
// another display may be), concave shoulders of radius s into sides at left
// and right, down to bottom, with corners of radius b. Measured from the window's top left, like pip-main.js's
// hangingPath(), and drawn in a layer of height h (y up).
static CGPathRef hangingPath(CGFloat left, CGFloat right, CGFloat bottom, CGFloat s, CGFloat b, CGFloat lift, CGFloat h) {
  const CGFloat k = 0.5523;  // quarter circles as Béziers
  CGMutablePathRef p = CGPathCreateMutable();
#define P(x, y) (x), h - (y)
  CGPathMoveToPoint(p, NULL, P(left - s, lift));
  CGPathAddLineToPoint(p, NULL, P(right + s, lift));
  CGPathAddCurveToPoint(p, NULL, P(right + s - s * k, lift), P(right, lift + s - s * k), P(right, lift + s));
  CGPathAddLineToPoint(p, NULL, P(right, bottom - b));
  CGPathAddCurveToPoint(p, NULL, P(right, bottom - b + b * k), P(right - b + b * k, bottom), P(right - b, bottom));
  CGPathAddLineToPoint(p, NULL, P(left + b, bottom));
  CGPathAddCurveToPoint(p, NULL, P(left + b - b * k, bottom), P(left, bottom - b + b * k), P(left, bottom - b));
  CGPathAddLineToPoint(p, NULL, P(left, lift + s));
  CGPathAddCurveToPoint(p, NULL, P(left, lift + s - s * k), P(left - s + s * k, lift), P(left - s, lift));
#undef P
  CGPathCloseSubpath(p);
  return p;
}

static NSString* const kRim = @"muta-rim";

// The glare: a thin light line just inside the shape's edge, like Liquid
// Glass's rim, brightest along the bottom and fading out towards the top,
// where the shape meets the notch and the screen's edge. A gradient seen
// through a stroke of the shape's path (the view's mask keeps its inner half).
static CAShapeLayer* rimLine(CALayer* layer, NSRect bounds) {
  CAGradientLayer* rim = nil;
  for (CALayer* sub in layer.sublayers)
    if ([sub.name isEqualToString:kRim]) rim = (CAGradientLayer*)sub;
  if (!rim) {
    rim = [CAGradientLayer layer];
    rim.name = kRim;
    // Layers here are y up: the bottom of the window is at 0.
    rim.startPoint = CGPointMake(0.5, 0);
    rim.endPoint = CGPointMake(0.5, 1);
    rim.colors = @[
      (__bridge id)[NSColor colorWithWhite:1 alpha:0.16].CGColor,
      (__bridge id)[NSColor colorWithWhite:1 alpha:0.05].CGColor,
      (__bridge id)[NSColor colorWithWhite:1 alpha:0.0].CGColor,
    ];
    rim.locations = @[ @0, @0.45, @0.8 ];
    CAShapeLayer* line = [CAShapeLayer layer];
    line.fillColor = nil;
    line.strokeColor = NSColor.blackColor.CGColor;
    line.lineWidth = 2;  // 1px of it inside the shape
    rim.mask = line;
    [layer addSublayer:rim];
  }
  rim.frame = bounds;
  rim.mask.frame = bounds;
  return (CAShapeLayer*)rim.mask;
}

static void morphPath(CAShapeLayer* shape, CGPathRef path, double seconds, CAMediaTimingFunction* curve) {
  if (seconds > 0) {
    CABasicAnimation* morph = [CABasicAnimation animationWithKeyPath:@"path"];
    morph.fromValue = (__bridge id)(shape.presentationLayer ? shape.presentationLayer.path : shape.path);
    morph.toValue = (__bridge id)path;
    morph.duration = seconds;
    morph.timingFunction = curve;
    [shape addAnimation:morph forKey:@"path"];
  }
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  shape.path = path;
  [CATransaction commit];
}

// Masks view to the hanging shape, from o's left, right, bottom, shoulder,
// radius and lift, with the glare along its edge; over seconds along the
// curve (x1, y1, x2, y2) when given.
static void setHangingShape(napi_env env, napi_value o, NSView* view, double seconds) {
  view.wantsLayer = YES;
  CALayer* layer = view.layer;
  NSRect bounds = view.bounds;
  CAShapeLayer* mask = [layer.mask isKindOfClass:CAShapeLayer.class] ? (CAShapeLayer*)layer.mask : nil;
  if (!mask) {
    mask = [CAShapeLayer layer];
    mask.fillColor = NSColor.blackColor.CGColor;
    layer.mask = mask;
  }
  mask.frame = bounds;
  CGPathRef path = hangingPath(number(env, o, "left", 0), number(env, o, "right", bounds.size.width),
                               number(env, o, "bottom", bounds.size.height), number(env, o, "shoulder", 0),
                               number(env, o, "radius", 0), number(env, o, "lift", 0), bounds.size.height);
  CAMediaTimingFunction* curve = [CAMediaTimingFunction functionWithControlPoints:number(env, o, "x1", 0.25)
                                                                                 :number(env, o, "y1", 0.1)
                                                                                 :number(env, o, "x2", 0.25)
                                                                                 :number(env, o, "y2", 1)];
  morphPath(mask, path, seconds, curve);
  morphPath(rimLine(layer, bounds), path, seconds, curve);
  CGPathRelease(path);
}

// Morphs the blur (or glass) to the hanging shape described by o, over seconds.
static napi_value shape(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  NSView* view = argc > 0 ? viewFrom(env, argv[0]) : nil;
  NSView* glass = view.window ? existing(view.window.contentView) : nil;
  if (!glass || argc < 2) return result(env, false);
  double seconds = 0;
  if (argc > 2) napi_get_value_double(env, argv[2], &seconds);
  setHangingShape(env, argv[1], glass, seconds);
  return result(env, true);
}

// macOS's blur materials blur only so much; their backdrop layer's Gaussian
// blur can be turned up (Core Animation's private filters, by key, so
// nothing breaks where they're missing). Returns how many it changed.
// pure: just the blur, without the material's own grey tint and colour
// changes (its other filters, and the layers drawn over the backdrop).
static int setBlurRadius(CALayer* layer, double radius, bool pure) {
  int changed = 0;
  bool backdrop = [NSStringFromClass(layer.class) containsString:@"Backdrop"];
  if (backdrop && layer.filters.count) {
    NSMutableArray* filters = [NSMutableArray array];
    for (id filter in layer.filters) {
      bool blur = false;
      @try {
        NSString* name = [filter valueForKey:@"name"];
        NSString* type = [filter respondsToSelector:NSSelectorFromString(@"type")] ? [filter valueForKey:@"type"] : nil;
        blur = [name isEqual:@"gaussianBlur"] || [type isEqual:@"gaussianBlur"];
        if (blur) {
          [filter setValue:@(radius) forKey:@"inputRadius"];
          changed++;
        }
      } @catch (NSException* e) {
      }
      if (blur || !pure) [filters addObject:filter];
    }
    layer.filters = filters;
  }
  for (CALayer* sub in layer.sublayers) {
    if ([sub.name isEqualToString:kRim]) continue;  // the glare, ours
    bool hasBackdrop = [NSStringFromClass(sub.class) containsString:@"Backdrop"] || sub.sublayers.count;
    // The tint and fill layers over the backdrop.
    if (pure && !hasBackdrop) sub.hidden = YES;
    else changed += setBlurRadius(sub, radius, pure);
  }
  return changed;
}

// The backdrop is made once the view is on screen, so it's turned up then,
// and again in case the material redraws it.
static void raiseBlur(NSVisualEffectView* blur, double radius, bool pure) {
  for (NSNumber* delay in @[ @0.05, @0.3, @1.0 ]) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay.doubleValue * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      if (blur.layer) setBlurRadius(blur.layer, radius, pure);
    });
  }
}

static void styleBlur(napi_env env, napi_value o, NSVisualEffectView* blur, double radius) {
  blur.material = (NSVisualEffectMaterial)number(env, o, "material", NSVisualEffectMaterialHUDWindow);
  blur.blendingMode = NSVisualEffectBlendingModeBehindWindow;
  blur.state = NSVisualEffectStateActive;
  blur.wantsLayer = YES;
  double blurRadius = number(env, o, "blurRadius", 0);
  if (blurRadius > 0) raiseBlur(blur, blurRadius, flag(env, o, "pure", false));
  double shoulders = number(env, o, "shoulders", 0);
  if (shoulders > 0) {
    // Shaped by shape() (pip-main.js); until then, the whole window.
    blur.layer.cornerRadius = 0;
    blur.layer.masksToBounds = NO;
  } else {
    blur.layer.mask = nil;
    blur.layer.cornerRadius = radius;
    blur.layer.cornerCurve = kCACornerCurveContinuous;
    blur.layer.masksToBounds = YES;
  }
}

API_AVAILABLE(macos(26.0))
static void styleGlass(napi_env env, napi_value o, NSGlassEffectView* glass, double radius) {
  glass.cornerRadius = radius;
  glass.style = (!o || flag(env, o, "clear", true)) ? NSGlassEffectViewStyleClear : NSGlassEffectViewStyleRegular;
  double tint = o ? number(env, o, "tint", 0) : 0;
  CGFloat white = (!o || flag(env, o, "dark", true)) ? 0 : 1;  // a dark tint, or a light one
  glass.tintColor = tint > 0 ? [NSColor colorWithWhite:white alpha:tint] : nil;
}

static napi_value apply(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  NSView* view = argc > 0 ? viewFrom(env, argv[0]) : nil;
  NSWindow* window = view.window;
  if (!window) return result(env, false);
  NSView* root = window.contentView;
  napi_value o = argc > 1 ? argv[1] : NULL;
  double radius = o ? number(env, o, "radius", 16) : 16;
  bool wantBlur = o && flag(env, o, "blur", false);
  // Hanging from the top (shoulders), it has no shadow, whose edge would outline it.
  bool hanging = o && number(env, o, "shoulders", 0) > 0;
  double alpha = o ? number(env, o, "alpha", 1) : 1;
  NSView* old = existing(root);
  NSView* layerView = nil;
  // The same kind of view already there is changed in place, so it doesn't flash.
  if (wantBlur && [old isKindOfClass:NSVisualEffectView.class]) {
    styleBlur(env, o, (NSVisualEffectView*)old, radius);
    layerView = old;
  } else if (@available(macOS 26.0, *)) {
    if (!wantBlur && [old isKindOfClass:NSGlassEffectView.class]) {
      NSGlassEffectView* glass = (NSGlassEffectView*)old;
      styleGlass(env, o, glass, radius);
      layerView = old;
    }
  }
  if (layerView) {
    layerView.alphaValue = alpha;
  } else {
    if (wantBlur) {
      NSVisualEffectView* blur = [[NSVisualEffectView alloc] initWithFrame:root.bounds];
      styleBlur(env, o, blur, radius);
      layerView = blur;
    } else if (@available(macOS 26.0, *)) {
      NSGlassEffectView* glass = [[NSGlassEffectView alloc] initWithFrame:root.bounds];
      styleGlass(env, o, glass, radius);
      layerView = glass;
    } else {
      [old removeFromSuperview];
      return result(env, false);  // Liquid Glass needs macOS 26
    }
    layerView.identifier = kId;
    layerView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    layerView.alphaValue = alpha;
    [root addSubview:layerView positioned:NSWindowBelow relativeTo:nil];
    // Switching kind: the old one fades out over the new one, then goes.
    if (old) {
      old.identifier = nil;
      [old removeFromSuperview];
      [root addSubview:old positioned:NSWindowAbove relativeTo:layerView];
      [NSAnimationContext runAnimationGroup:^(NSAnimationContext* context) {
        context.duration = 0.25;
        old.animator.alphaValue = 0;
      } completionHandler:^{
        [old removeFromSuperview];
      }];
    }
  }
  // Glass adapts to what's behind it, flipping between a light and a dark
  // look as that changes; held to one look (dark, or light for Obsidian's
  // light theme), it stays put.
  NSAppearance* look = [NSAppearance appearanceNamed:(!o || flag(env, o, "dark", true)) ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
  layerView.appearance = look;
  window.appearance = look;
  window.opaque = NO;
  window.backgroundColor = NSColor.clearColor;
  window.hasShadow = !hanging;
  [window invalidateShadow];
  return result(env, true);
}

static napi_value removeGlass(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  NSView* view = argc > 0 ? viewFrom(env, argv[0]) : nil;
  NSView* glass = view.window ? existing(view.window.contentView) : nil;
  [glass removeFromSuperview];
  return result(env, glass != nil);
}

// Clicking the window doesn't bring its app forward (like a floating panel),
// through AppKit's private _setPreventsActivation:, when it's there.
static napi_value preventActivation(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  NSWindow* window = argc > 0 ? viewFrom(env, argv[0]).window : nil;
  SEL sel = NSSelectorFromString(@"_setPreventsActivation:");
  if (!window || ![window respondsToSelector:sel]) return result(env, false);
  void (*set)(id, SEL, BOOL) = (void (*)(id, SEL, BOOL))[window methodForSelector:sel];
  set(window, sel, YES);
  return result(env, true);
}

// Fades the glass to alpha over seconds (Core Animation, so the page
// doesn't redraw for it). False when there's no glass to fade.
static napi_value fade(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  NSView* view = argc > 0 ? viewFrom(env, argv[0]) : nil;
  NSView* glass = view.window ? existing(view.window.contentView) : nil;
  if (!glass || argc < 3) return result(env, false);
  double alpha = 1, seconds = 0;
  napi_get_value_double(env, argv[1], &alpha);
  napi_get_value_double(env, argv[2], &seconds);
  if (seconds <= 0) {
    glass.alphaValue = alpha;
    return result(env, true);
  }
  [NSAnimationContext runAnimationGroup:^(NSAnimationContext* context) {
    context.duration = seconds;
    context.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseOut];
    glass.animator.alphaValue = alpha;
  }];
  return result(env, true);
}

// Lets the window be moved up into the menu bar, to the notch: Electron's
// window only skips AppKit's keep-it-below-the-menu-bar rule when it's
// allowed to be larger than the screen.
static napi_value allowAboveMenuBar(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  NSWindow* window = argc > 0 ? viewFrom(env, argv[0]).window : nil;
  if (!window || ![window respondsToSelector:NSSelectorFromString(@"setEnableLargerThanScreen:")])
    return result(env, false);
  [window setValue:@YES forKey:@"enableLargerThanScreen"];
  return result(env, true);
}

static NSString* const kPanel = @"muta-panel";
// Bumped by every panel() call, so a panel going away isn't taken away after it's been asked back.
static int panelGeneration = 0;

// A rect from the page's top left (CSS pixels, y down) in root's coordinates (y up).
static NSRect fromTop(NSView* root, double x, double y, double width, double height) {
  return NSMakeRect(x, root.bounds.size.height - y - height, width, height);
}

static void animateRadius(CALayer* layer, double radius, double seconds, CAMediaTimingFunction* curve) {
  if (seconds > 0) {
    CABasicAnimation* round = [CABasicAnimation animationWithKeyPath:@"cornerRadius"];
    round.fromValue = @((layer.presentationLayer ?: layer).cornerRadius);
    round.toValue = @(radius);
    round.duration = seconds;
    round.timingFunction = curve;
    [layer addAnimation:round forKey:@"cornerRadius"];
  }
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  layer.cornerRadius = radius;
  [CATransaction commit];
}

static napi_value panel(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  NSView* view = argc > 0 ? viewFrom(env, argv[0]) : nil;
  NSView* root = view.window.contentView;
  if (!root || argc < 2) return result(env, false);
  napi_value o = argv[1];
  bool show = flag(env, o, "show", true);
  double seconds = number(env, o, "seconds", 0);
  CAMediaTimingFunction* curve = [CAMediaTimingFunction functionWithControlPoints:number(env, o, "x1", 0.32)
                                                                                 :number(env, o, "y1", 0.72)
                                                                                 :number(env, o, "x2", 0)
                                                                                 :number(env, o, "y2", 1)];
  NSRect from = fromTop(root, number(env, o, "fromX", 0), number(env, o, "fromY", 0), number(env, o, "fromWidth", 0),
                        number(env, o, "fromHeight", 0));
  double fromRadius = number(env, o, "fromRadius", 0);
  NSVisualEffectView* p = nil;
  for (NSView* v in root.subviews)
    if ([v.identifier isEqualToString:kPanel]) p = (NSVisualEffectView*)v;
  int generation = ++panelGeneration;
  if (!p) {
    if (!show) return result(env, false);
    p = [[NSVisualEffectView alloc] initWithFrame:from];
    p.identifier = kPanel;
    p.blendingMode = NSVisualEffectBlendingModeBehindWindow;
    p.state = NSVisualEffectStateActive;
    p.wantsLayer = YES;
    p.layer.cornerCurve = kCACornerCurveContinuous;
    p.layer.masksToBounds = YES;
    p.layer.cornerRadius = fromRadius;
    p.alphaValue = 0;
    // Over the window's glass, under the page.
    NSView* glass = existing(root);
    if (glass) [root addSubview:p positioned:NSWindowAbove relativeTo:glass];
    else [root addSubview:p positioned:NSWindowBelow relativeTo:nil];
  }
  p.material = (NSVisualEffectMaterial)number(env, o, "material", NSVisualEffectMaterialMenu);
  p.appearance = [NSAppearance appearanceNamed:flag(env, o, "dark", true) ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
  NSRect to = show ? fromTop(root, number(env, o, "x", 0), number(env, o, "y", 0), number(env, o, "width", 0),
                             number(env, o, "height", 0))
                   : from;
  double radius = show ? number(env, o, "radius", 10) : fromRadius;
  animateRadius(p.layer, radius, seconds, curve);
  [NSAnimationContext runAnimationGroup:^(NSAnimationContext* context) {
    context.duration = seconds;
    context.timingFunction = curve;
    context.allowsImplicitAnimation = YES;
    p.animator.frame = to;
    // Shown at once; going, it fades over the last part of the way.
    if (show) p.alphaValue = 1;
  } completionHandler:^{
    if (show || generation != panelGeneration) return;
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext* context) {
      context.duration = 0.08;
      p.animator.alphaValue = 0;
    } completionHandler:^{
      if (generation == panelGeneration) [p removeFromSuperview];
    }];
  }];
  return result(env, true);
}

static void setNumber(napi_env env, napi_value object, const char* key, double value) {
  napi_value v;
  napi_create_double(env, value, &v);
  napi_set_named_property(env, object, key, v);
}

// The camera notch of each screen that has one, in Electron's coordinates
// (points, y down from the top of the primary screen). It sits centred
// between the menu bar's two unobscured top corners.
static napi_value notches(napi_env env, napi_callback_info info) {
  napi_value list;
  napi_create_array_with_length(env, 0, &list);
  NSArray<NSScreen*>* screens = NSScreen.screens;
  if (!screens.count) return list;
  CGFloat primaryHeight = screens[0].frame.size.height;
  uint32_t i = 0;
  if (@available(macOS 12.0, *)) {
    for (NSScreen* screen in screens) {
      CGFloat height = screen.safeAreaInsets.top;
      NSRect left = screen.auxiliaryTopLeftArea;
      NSRect right = screen.auxiliaryTopRightArea;
      if (height <= 0 || NSIsEmptyRect(left) || NSIsEmptyRect(right)) continue;
      NSRect frame = screen.frame;
      CGFloat width = frame.size.width - left.size.width - right.size.width;
      if (width <= 0) continue;
      napi_value rect;
      napi_create_object(env, &rect);
      setNumber(env, rect, "x", frame.origin.x + (frame.size.width - width) / 2);
      setNumber(env, rect, "y", primaryHeight - (frame.origin.y + frame.size.height));
      setNumber(env, rect, "width", width);
      setNumber(env, rect, "height", height);
      napi_set_element(env, list, i++, rect);
    }
  }
  return list;
}

__attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "apply", 5, apply, NULL, &fn);
  napi_set_named_property(env, exports, "apply", fn);
  napi_create_function(env, "remove", 6, removeGlass, NULL, &fn);
  napi_set_named_property(env, exports, "remove", fn);
  napi_create_function(env, "preventActivation", 17, preventActivation, NULL, &fn);
  napi_set_named_property(env, exports, "preventActivation", fn);
  napi_create_function(env, "fade", 4, fade, NULL, &fn);
  napi_set_named_property(env, exports, "fade", fn);
  napi_create_function(env, "allowAboveMenuBar", 17, allowAboveMenuBar, NULL, &fn);
  napi_set_named_property(env, exports, "allowAboveMenuBar", fn);
  napi_create_function(env, "shape", 5, shape, NULL, &fn);
  napi_set_named_property(env, exports, "shape", fn);
  napi_create_function(env, "notches", 7, notches, NULL, &fn);
  napi_set_named_property(env, exports, "notches", fn);
  napi_create_function(env, "panel", 5, panel, NULL, &fn);
  napi_set_named_property(env, exports, "panel", fn);
  return exports;
}
