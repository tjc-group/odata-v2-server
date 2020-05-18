import { ServiceMetadata } from "@tjc-group/odata-v2-service-metadata";
import { ServiceDocument } from "@tjc-group/odata-v4-service-document";
import { Edm as Metadata } from "@tjc-group/odata-v4-metadata";
import * as ODataParser from "@tjc-group/odata-v2-parser";
import { Token, TokenType } from "@tjc-group/odata-v2-parser/lib/lexer";
import * as express from "express";
import * as http from "http";
import * as bodyParser from "body-parser";
import * as cors from "cors";
import { Transform, TransformOptions, Duplex } from "stream";
import { ODataResult } from "./result";
import { ODataController } from "./controller";
import * as odata from "./odata";
import { ODataBase, IODataConnector } from "./odata";
import { createMetadataJSON } from "./metadata";
import { ODataProcessor, ODataProcessorOptions, ODataMetadataType } from "./processor";
import { HttpRequestError, UnsupportedMediaTypeError } from "./error";
import { ContainerBase } from "./edm";
import { Readable, Writable } from "stream";
import * as async from "async";
import * as deepmerge from "deepmerge";

/** HTTP context interface when using the server HTTP request handler */
export interface ODataHttpContext {
    url: string
    method: string
    protocol: "http" | "https"
    host: string
    base: string
    request: express.Request & Readable
    response: express.Response & Writable,
    processor: ODataProcessor & Transform
}

function ensureODataMetadataType(req, res) {
    let metadata: ODataMetadataType = ODataMetadataType.minimal;
    if (req.headers && req.headers.accept && req.headers.accept.indexOf("odata.metadata=") >= 0) {
        if (req.headers.accept.indexOf("odata.metadata=full") >= 0) metadata = ODataMetadataType.full;
        else if (req.headers.accept.indexOf("odata.metadata=none") >= 0) metadata = ODataMetadataType.none;
    }

    res["metadata"] = metadata;
}
function ensureODataContentType(req, res, contentType?) {
    contentType = contentType || "application/json";
    if (contentType.indexOf("odata.metadata=") < 0) contentType += `;odata.metadata=${ODataMetadataType[res["metadata"]]}`;
    if (contentType.indexOf("odata.streaming=") < 0) contentType += ";odata.streaming=true";
    if (contentType.indexOf("IEEE754Compatible=") < 0) contentType += ";IEEE754Compatible=false";
    if (req.headers.accept && req.headers.accept.indexOf("charset") > 0) {
        contentType += `;charset=${res["charset"]}`;
    }
    res.contentType(contentType);
}
function ensureODataHeaders(req, res, next?) {
    res.setHeader("OData-Version", "2.0");

    ensureODataMetadataType(req, res);
    let charset = req.headers["accept-charset"] || "utf-8";
    res["charset"] = charset;
    ensureODataContentType(req, res);

    if ((req.headers.accept && req.headers.accept.indexOf("charset") < 0) || req.headers["accept-charset"]) {
        const bufferEncoding = {
            "utf-8": "utf8",
            "utf-16": "utf16le"
        };
        let origsend = res.send;
        res.send = <any>((data) => {
            if (typeof data == "object") data = JSON.stringify(data);
            origsend.call(res, Buffer.from(data, bufferEncoding[charset]));
        });
    }

    if (typeof next == "function") next();
}

interface ResultFunction {
    (err: any, result?: any): void;
}

/** ODataServer base class to be extended by concrete OData Server data sources */
export class ODataServerBase extends Transform {
    private static _metadataCache: any
    static namespace: string
    static container = new ContainerBase();
    static parser = ODataParser;
    static connector: IODataConnector
    static validator: (odataQuery: string | Token) => null;
    static errorHandler: express.ErrorRequestHandler = ODataErrorHandler;
    private serverType: typeof ODataServer



    static batchRequestHandler(handler: (req: express.Request, res: express.Response, next: express.NextFunction) => void) {

        return (req: express.Request, res: express.Response, next: express.NextFunction) => {
            try {
                if (req.body && req.body.operations) {

                    function iterateOperation(operation, index, callback: ResultFunction) {
                        let result: any = {};
                        var cb: ResultFunction = callback;

                        function invokeCallbackOnce(err: any, result?: any) {
                            if (cb) {
                                if (result) {
                                    result = Object.assign({}, operation, result)
                                }
                                cb.call(null, err, result);
                                cb = undefined;
                            }
                        }
                        Object.assign(result, operation, { index: index });
                        if (operation.operations) { // nested batch, can be changeset inside batch
                            async.mapValuesLimit(operation.operations, 5, iterateOperation, function (error, results) {
                                invokeCallbackOnce(null, Object.assign({}, operation, { operations: results }));
                            });
                        } else {

                           let fakeReq = Object.assign({}, req, {
                                url: operation.resourcePath,
                                originalUrl: operation.resourcePath,
                                path: operation.resourcePath,
                                method: operation.method,
                                headers: {
                                    "content-type": operation.contentType
                                },
                                body: operation.payload,
                                secure: req.secure,
                                protocol: req.protocol
                            })

                            let fakeRes: any;

                            let endFn = <any>((data: any, encoding: string, endCallback: express.NextFunction): any => {
                                result.statusCode = result.statusCode || 200;
                                result.payload = data;
                                invokeCallbackOnce(null, result);
                                return fakeRes;
                            })

                            fakeRes = Object.assign({}, res, {
                                setHeader: <any>((key, value) => {
                                    result.headers = result.headers || {};
                                    result.headers[key] = value;
                                }),
                                end: endFn,
                                send: endFn,
                                json: endFn,
                                contentType: <any>((contentType) => {
                                    result.contentType = contentType;
                                }),
                                status: <any>((statusCode: number): any => {
                                    result.statusCode = statusCode;
                                    return fakeRes;
                                })
                            })

                            handler(fakeReq, fakeRes, function (error) {
                                invokeCallbackOnce(null, { error: error });
                            });
                        }
                    }

                    try {
                        async.mapValuesLimit(req.body.operations, 5,
                            iterateOperation,
                            function (error, result) {
                                function buildBatchResponse(boundary, operations): any {
                                    return Object
                                        .keys(operations)
                                        .sort()
                                        .map(index => {
                                            let operation = operations[index];
                                            let content = ""
                                            let payload;

                                            // use CRLF as line  separator according to https://www.w3.org/Protocols/rfc1341/7_2_Multipart.html

                                            if (operation.operations) {
                                                payload = buildBatchResponse(operation.boundary, operation.operations)
                                                content += "Content-Type: multipart/mixed; boundary=" +
                                                    operation.boundary + "\r\nContent-Length: " + payload.length + "\r\n\r\n" + payload + "\r\n";
                                            } else {
                                                content += "Content-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\n"
                                                if (operation.error) {
                                                    let statusCode = operation.error.statusCode || 500;
                                                    payload = JSON.stringify({
                                                        "error": {
                                                            "code": statusCode,
                                                            "message": {
                                                                "lang": "en-US",
                                                                "value": operation.error.message
                                                            },
                                                            "resource": operation.resourcePath
                                                        }
                                                    });
                                                    content += "HTTP/1.1 " + statusCode + " " + operation.error.message + "\r\n" +
                                                        "Content-Type: application/json;charset=utf-8\r\n\r\n" + payload + "\r\n";
                                                } else {
                                                    payload = JSON.stringify(operation.payload);
                                                    content += "HTTP/1.1 " + operation.statusCode + " OK\r\n" +
                                                        "Content-Type: " + (operation.contentType || "application/json;charset=utf-8") + "\r\n\r\n" + payload + "\r\n";
                                                }
                                            }
                                            return "--" + boundary + "\r\n" + content;
                                        }).join("\r\n") + "\r\n--" + boundary + "--"
                                }

                                let content = buildBatchResponse(req.body.boundary, result);

                                res.charset = "utf-8";
                                res.contentType("multipart/mixed;boundary=" + req.body.boundary);
                                res.statusMessage = "Accepted";
                                res.status(202).send(content);
                            });
                    } catch (error) {
                        next(error);
                    }
                } else {
                    throw new HttpRequestError(415, "Request payload must not be blank for batch request")
                }
            } catch (err) {
                next(err);
            }
        };
    }
    static requestHandler() {
        return (req: express.Request, res: express.Response, next: express.NextFunction) => {
            try {
                ensureODataHeaders(req, res);
                let processor = this.createProcessor({
                    url: req.url,
                    method: req.method,
                    protocol: req.secure ? "https" : "http",
                    host: req.headers.host,
                    base: req.baseUrl,
                    request: req,
                    response: res
                }, <ODataProcessorOptions>{
                    metadata: res["metadata"]
                });
                processor.on("header", (headers) => {
                    for (let prop in headers) {
                        if (prop.toLowerCase() == "content-type") {
                            ensureODataContentType(req, res, headers[prop]);
                        } else {
                            res.setHeader(prop, headers[prop]);
                        }
                    }
                });
                let hasError = false;
                processor.on("data", (chunk, encoding, done) => {
                    if (!hasError) {
                        res.write(chunk, encoding, done);
                    }
                });
                let body = req.body && Object.keys(req.body).length > 0 ? req.body : req;
                let origStatus = res.statusCode;
                processor.execute(body).then((result: ODataResult) => {
                    try {
                        if (result) {
                            res.status((origStatus != res.statusCode && res.statusCode) || result.statusCode || 200);
                            if (!res.headersSent) {
                                ensureODataContentType(req, res, result.contentType || "text/plain");
                            }
                            if (typeof result.body != "undefined") {
                                if (typeof result.body != "object") res.send("" + result.body);
                                else if (!res.headersSent) res.send(result.body);
                            }
                        }
                        res.end();
                    } catch (err) {
                        hasError = true;
                        next(err);
                    }
                }, (err) => {
                    hasError = true;
                    next(err);
                });
            } catch (err) {
                next(err);
            }
        };
    }

    static execute<T>(url: string, body?: object): Promise<ODataResult<T>>;
    static execute<T>(url: string, method?: string, body?: object): Promise<ODataResult<T>>;
    static execute<T>(context: object, body?: object): Promise<ODataResult<T>>;
    static execute<T>(url: string | object, method?: string | object, body?: object): Promise<ODataResult<T>> {
        let context: any = {};
        if (typeof url == "object") {
            context = Object.assign(context, url);
            if (typeof method == "object") {
                body = method;
            }
            url = undefined;
            method = undefined;
        } else if (typeof url == "string") {
            context.url = url;
            if (typeof method == "object") {
                body = method;
                method = "POST";
            }
            context.method = method || "GET";
        }
        context.method = context.method || "GET";
        let processor = this.createProcessor(context, <ODataProcessorOptions>{
            objectMode: true,
            metadata: context.metadata || ODataMetadataType.minimal
        });
        let values = [];
        let flushObject;
        let response = "";
        if (context.response instanceof Writable) processor.pipe(context.response);
        processor.on("data", (chunk: any) => {
            if (!(typeof chunk == "string" || chunk instanceof Buffer)) {
                if (chunk["@odata.context"] && chunk.value && Array.isArray(chunk.value) && chunk.value.length == 0) {
                    flushObject = chunk;
                    flushObject.value = values;
                } else {
                    values.push(chunk);
                }
            } else response += chunk.toString();
        });
        return processor.execute(context.body || body).then((result: ODataResult<T>) => {
            if (flushObject) {
                result.body = flushObject;
                if (!result.elementType || typeof result.elementType == "object") result.elementType = flushObject.elementType;
                delete flushObject.elementType;
                result.contentType = result.contentType || "application/json";
            } else if (result && response) {
                result.body = <any>response;
            }
            return result;
        });
    }

    constructor(opts?: TransformOptions) {
        super(Object.assign(<TransformOptions>{
            objectMode: true
        }, opts));
        this.serverType = Object.getPrototypeOf(this).constructor;
    }

    _transform(chunk: any, _?: string, done?: Function) {
        if ((chunk instanceof Buffer) || typeof chunk == "string") {
            try {
                chunk = JSON.parse(chunk.toString());
            } catch (err) {
                return done(err);
            }
        }
        this.serverType.execute(chunk).then((result) => {
            this.push(result);
            if (typeof done == "function") done();
        }, <any>done);
    }

    _flush(done?: Function) {
        if (typeof done == "function") done();
    }

    static createProcessor(context: any, options?: ODataProcessorOptions) {
        return new ODataProcessor(context, this, options);
    }

    static $metadata(): ServiceMetadata;
    static $metadata(metadata: Metadata.Edmx | any);
    static $metadata(metadata?): ServiceMetadata {
        if (metadata) {
            if (!(metadata instanceof Metadata.Edmx)) {
                if (metadata.version && metadata.dataServices && Array.isArray(metadata.dataServices.schema)) this._metadataCache = ServiceMetadata.processMetadataJson(metadata);
                else this._metadataCache = ServiceMetadata.defineEntities(metadata);
            }
        }
        return this._metadataCache || (this._metadataCache = ServiceMetadata.processMetadataJson(createMetadataJSON(this)));
    }

    static document(): ServiceDocument {
        return ServiceDocument.processEdmx(this.$metadata().edmx);
    }

    static addController(controller: typeof ODataController, isPublic?: boolean);
    static addController(controller: typeof ODataController, isPublic?: boolean, elementType?: Function);
    static addController(controller: typeof ODataController, entitySetName?: string, elementType?: Function);
    static addController(controller: typeof ODataController, entitySetName?: string | boolean, elementType?: Function) {
        odata.controller(controller, <string>entitySetName, elementType)(this);
    }
    static getController(elementType: Function) {
        for (let i in this.prototype) {
            if (this.prototype[i] &&
                this.prototype[i].prototype &&
                this.prototype[i].prototype instanceof ODataController &&
                this.prototype[i].prototype.elementType == elementType) {
                return this.prototype[i];
            }
        }
        return null;
    }

    static parseMultiPart(contentType: string, content: string, parentType?: string): any {
        function skipBlankLines(lines: string[]): string[] {
            let line: string;
            do {
                line = lines.shift().trim();
            } while (lines.length > 0 && line.length === 0)
            if (line.length > 0) {
                lines.unshift(line);
            }
            return lines;
        }

        let parts: any;

        let boundaryMask = /boundary=((batch|changeset)_[\w-]+)/
        let matches = contentType.match(boundaryMask);
        if (matches) {
            let boundary = matches[1];
            let partType = matches[2];
            if ((parentType === "batch" && partType !== "changeset") || (parentType === partType)) {
                throw new HttpRequestError(415, "Nesting batch requests is not allowed");
            }
            parts = content.split("--" + boundary).filter(line => line.trim().length > 0 && line.trim() !== "--");
            parts = {
                type: partType,
                boundary: boundary,
                operations: parts.map(function (part, index): any {
                    function getTypeAndLength(obj: any, lines) {
                        let line: string
                        let matches: any
                        do {
                            line = lines.shift().trim();
                            if (contentTypeMask.test(line)) {
                                matches = line.match(contentTypeMask);
                                obj.contentType = matches && matches[1];
                            } else if (contentLengthMask.test(line)) {
                                matches = line.match(contentLengthMask);
                                obj.contentLength = matches && parseInt(matches[1], 10);
                            }
                        } while (line.length > 0);
                    }

                    const contentTypeMask = /^content-type:\s*(.+)/i
                    const contentLengthMask = /^content-length:\s*(.+)/i
                    const operationMask = /^(GET|PUT|POST|MERGE|DELETE|PATCH)\s+([^\s]+)/i
                    const changeOperations = /^(PUT|POST|MERGE|DELETE|PATCH)$/i

                    part.replace(/\r\n/g, "\n");

                    let lines = skipBlankLines(part.split("\n"));

                    let batchPart: any = {}

                    getTypeAndLength(batchPart, lines)
                    if (!batchPart.contentType) {
                        throw new HttpRequestError(415, "Incorrect body of batch request: no content-type in part " + index);
                    }

                    lines = skipBlankLines(lines);
                    if (batchPart.contentType.indexOf("multipart/mixed") >= 0) {
                        Object.assign(batchPart, ODataServerBase.parseMultiPart(batchPart.contentType, lines.join("\n"), partType));
                    } else {
                        let line = lines.shift().trim();

                        if (line && operationMask.test(line)) {
                            let lineParts = line.match(operationMask);
                            batchPart.method = lineParts[1];

                            if (partType === "changeset" && !changeOperations.test(batchPart.method)) {
                                throw new HttpRequestError(415, `Method ${batchPart.method} not allowed in change set ${boundary}`);
                            }
                            batchPart.resourcePath = lineParts[2];

                            getTypeAndLength(batchPart, lines)

                            batchPart.payload = []
                            while (line = lines.shift()) {
                                batchPart.payload.push(line);
                            }

                            batchPart.payload = batchPart.payload.join("\n");
                            if (batchPart.contentType.indexOf("application/json") >= 0) {
                                try {
                                    batchPart.payload = JSON.parse(batchPart.payload);
                                } catch (e) {
                                    throw new HttpRequestError(415, `Invalid payload in batch ${boundary}, part ${index}: ${e.message}`);
                                }
                            }

                        } else {
                            throw new HttpRequestError(415, `Incorrect batch syntax in batch ${boundary}, part ${index}`);
                        }
                    }

                    return batchPart;
                })
            };
        }

        return parts;
    }

    static parseBody(req: express.Request, res: express.Response, next: express.NextFunction) {
        if (req.is("multipart/mixed")) {
            bodyParser.raw({
                limit: "1mb",
                type: function () { return true; }
            })(req, res, (error) => {
                try {
                    if (Buffer.isBuffer(req.body)) {
                        req.body = req.body.toString()
                    }
                    var contentType = req.headers['content-type']; // for batch: multipart/mixed;boundary=batch_d844-4d5f-4761
                    req.body = ODataServerBase.parseMultiPart(contentType, req.body)
                    next();
                } catch (e) {
                    next(e)
                }
            });
        } else {
            bodyParser.json()(req, res, next);
        }
    }

    static create(): express.Router;
    static create(port: number): http.Server;
    static create(path: string, port: number): http.Server;
    static create(port: number, hostname: string): http.Server;
    static create(path?: string | RegExp | number, port?: number | string, hostname?: string): http.Server;
    static create(path?: string | RegExp | number, port?: number | string, hostname?: string): http.Server | express.Router {
        let server = this;
        let router = express.Router();
        router.use((req, _, next) => {
            req.url = req.url.replace(/[\/]+/g, "/").replace(":/", "://");
            if (req.headers["odata-maxversion"] && req.headers["odata-maxversion"] < "2.0") return next(new HttpRequestError(500, "Only OData version 2.0 supported"));
            next();
        });
        router.use(bodyParser.json());
        if ((<any>server).cors) router.use(cors());
        router.use((req, res, next) => {
            res.setHeader("OData-Version", "2.0");
            if (req.headers.accept &&
                req.headers.accept.indexOf("application/json") < 0 &&
                req.headers.accept.indexOf("multipart/mixed") < 0 && // batch processing
                req.headers.accept.indexOf("application/xml") < 0 &&
                req.headers.accept.indexOf("text/html") < 0 &&
                req.headers.accept.indexOf("*/*") < 0 &&
                req.headers.accept.indexOf("xml") < 0) {
                next(new UnsupportedMediaTypeError());
            } else next();
        });
        router.get("/", ensureODataHeaders, (req, _, next) => {
            if (typeof req.query == "object" && Object.keys(req.query).length > 0) return next(new HttpRequestError(500, "Unsupported query"));
            next();
        }, server.document().requestHandler());
        router.get("/\\$metadata", server.$metadata().requestHandler());
        router.post("/\\$batch",
            ODataServerBase.parseBody,
            server.batchRequestHandler(server.requestHandler()));
        router.use(server.requestHandler());
        router.use(server.errorHandler);

        if (typeof path == "number") {
            if (typeof port == "string") {
                hostname = "" + port;
            }
            port = parseInt(<any>path, 10);
            path = undefined;
        }
        if (typeof port == "number") {
            let app = express();
            app.use((<any>path) || "/", router);
            return app.listen(port, <any>hostname);
        }
        return router;
    }
}
export class ODataServer extends ODataBase<ODataServerBase, typeof ODataServerBase>(ODataServerBase) { }

/** ?????????? */
/** Create Express middleware for OData error handling */
export function ODataErrorHandler(err, _, res, next) {
    if (err) {
        if (res.headersSent) {
            return next(err);
        }
        let statusCode = err.statusCode || err.status || (res.statusCode < 400 ? 500 : res.statusCode);
        if (!res.statusCode || res.statusCode < 400) res.status(statusCode);
        res.send({
            error: {
                code: statusCode,
                message: err.message,
                stack: process.env.ODATA_V4_DISABLE_STACKTRACE ? undefined : err.stack
            }
        });
    } else next();
}

/** Create Express server for OData Server
 * @param server OData Server instance
 * @return       Express Router object
 */
export function createODataServer(server: typeof ODataServer): express.Router;
/** Create Express server for OData Server
 * @param server OData Server instance
 * @param port   port number for Express to listen to
 */
export function createODataServer(server: typeof ODataServer, port: number): http.Server;
/** Create Express server for OData Server
 * @param server OData Server instance
 * @param path   routing path for Express
 * @param port   port number for Express to listen to
 */
export function createODataServer(server: typeof ODataServer, path: string, port: number): http.Server;
/** Create Express server for OData Server
 * @param server   OData Server instance
 * @param port     port number for Express to listen to
 * @param hostname hostname for Express
 */
export function createODataServer(server: typeof ODataServer, port: number, hostname: string): http.Server;
/** Create Express server for OData Server
 * @param server   OData Server instance
 * @param path     routing path for Express
 * @param port     port number for Express to listen to
 * @param hostname hostname for Express
 * @return         Express Router object
 */
export function createODataServer(server: typeof ODataServer, path?: string | RegExp | number, port?: number | string, hostname?: string): http.Server | express.Router {
    return server.create(path, port, hostname);
}
