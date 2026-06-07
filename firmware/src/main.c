#include <stdlib.h>
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/net/http/client.h>
#include <zephyr/net/socket.h>
#include <zephyr/logging/log.h>
#include <zephyr/drivers/flash.h>
#include <zephyr/storage/flash_map.h>
#include <zephyr/fs/nvs.h>
#include <modem/nrf_modem_lib.h>
#include <modem/lte_lc.h>
#include <modem/modem_info.h>

LOG_MODULE_REGISTER(water_tank, LOG_LEVEL_INF);

#define GPIO_PORT DT_NODELABEL(gpio0)
#define TRIG_PIN 18
#define ECHO_PIN 14

#define FW_VERSION "1.0.0"
#define SAMPLE_INTERVAL_MINUTES 30
#define READINGS_PER_SAMPLE 5
#define CACHE_MAX 48
#define NVS_KEY_META 1
#define NVS_KEY_BASE 100

#define SERVER_HOST "ingest-bach.franks.nz"
#define SERVER_PORT "80"
#define SERVER_PATH "/api/readings"
#define API_KEY "E3tHk9vQp6Zs7N2xR4mL8cJ1uV5yT0wG"

struct cached_reading {
    float distance_cm;
    float level_percent;
    int signal_rssi;
    int signal_rsrp;
};

static size_t cache_count;
static size_t cache_head;

static const struct device *gpio_dev = DEVICE_DT_GET(GPIO_PORT);
static const struct gpio_dt_spec led = GPIO_DT_SPEC_GET_OR(DT_ALIAS(led0), gpios, {0});
static const struct gpio_dt_spec button = GPIO_DT_SPEC_GET_OR(DT_ALIAS(sw0), gpios, {0});
static struct gpio_callback button_cb_data;
static volatile bool button_pressed;
static struct nvs_fs nvs;
static bool nvs_ready;

struct cache_meta {
    uint16_t head;
    uint16_t count;
};

struct stored_reading {
    int16_t distance_cm;
    int16_t level_percent;
    int16_t signal_rssi;
    int16_t signal_rsrp;
};

static int get_signal_rsrp(void);
static int send_reading(const struct cached_reading *reading);
static void flush_cache(void);

static int cache_init(void) {
    nvs.flash_device = FLASH_AREA_DEVICE(storage);
    if (!device_is_ready(nvs.flash_device)) {
        LOG_ERR("NVS flash device not ready");
        return -ENODEV;
    }
    nvs.offset = FLASH_AREA_OFFSET(storage);
    struct flash_pages_info info;
    int err = flash_get_page_info_by_offs(nvs.flash_device, nvs.offset, &info);
    if (err) {
        LOG_ERR("Failed to get flash page info: %d", err);
        return err;
    }
    nvs.sector_size = info.size;
    nvs.sector_count = FLASH_AREA_SIZE(storage) / info.size;
    err = nvs_mount(&nvs);
    if (err) {
        LOG_ERR("NVS mount failed: %d", err);
        return err;
    }
    struct cache_meta meta = {0};
    int rc = nvs_read(&nvs, NVS_KEY_META, &meta, sizeof(meta));
    if (rc > 0) {
        cache_head = meta.head;
        cache_count = meta.count;
    } else {
        cache_head = 0;
        cache_count = 0;
    }
    nvs_ready = true;
    LOG_INF("NVS ready: count=%d", (int)cache_count);
    return 0;
}

static int cache_save_meta(void) {
    struct cache_meta meta = {
        .head = (uint16_t)cache_head,
        .count = (uint16_t)cache_count,
    };
    return nvs_write(&nvs, NVS_KEY_META, &meta, sizeof(meta));
}

static bool cache_push(struct cached_reading reading) {
    if (!nvs_ready) {
        return false;
    }
    struct stored_reading stored = {
        .distance_cm = (int16_t)(reading.distance_cm + 0.5f),
        .level_percent = (int16_t)(reading.level_percent + 0.5f),
        .signal_rssi = (int16_t)reading.signal_rssi,
        .signal_rsrp = (int16_t)reading.signal_rsrp,
    };
    uint16_t key = NVS_KEY_BASE + (uint16_t)cache_head;
    int err = nvs_write(&nvs, key, &stored, sizeof(stored));
    if (err < 0) {
        LOG_ERR("NVS write failed: %d", err);
        return false;
    }
    cache_head = (cache_head + 1) % CACHE_MAX;
    if (cache_count < CACHE_MAX) {
        cache_count++;
    }
    cache_save_meta();
    return true;
}

static bool cache_peek(struct cached_reading *out) {
    if (!nvs_ready || cache_count == 0) {
        return false;
    }
    size_t tail = (cache_head + CACHE_MAX - cache_count) % CACHE_MAX;
    uint16_t key = NVS_KEY_BASE + (uint16_t)tail;
    struct stored_reading stored = {0};
    int rc = nvs_read(&nvs, key, &stored, sizeof(stored));
    if (rc <= 0) {
        return false;
    }
    out->distance_cm = (float)stored.distance_cm;
    out->level_percent = (float)stored.level_percent;
    out->signal_rssi = stored.signal_rssi;
    out->signal_rsrp = stored.signal_rsrp;
    return true;
}

static bool cache_pop(struct cached_reading *out) {
    if (!cache_peek(out)) {
        return false;
    }
    size_t tail = (cache_head + CACHE_MAX - cache_count) % CACHE_MAX;
    uint16_t key = NVS_KEY_BASE + (uint16_t)tail;
    nvs_delete(&nvs, key);
    cache_count--;
    cache_save_meta();
    return true;
}

static float read_distance_once_cm(void) {
    int64_t start_cycles;
    int64_t end_cycles;
    int64_t duration_us;

    gpio_pin_set(gpio_dev, TRIG_PIN, 0);
    k_busy_wait(2);
    gpio_pin_set(gpio_dev, TRIG_PIN, 1);
    k_busy_wait(10);
    gpio_pin_set(gpio_dev, TRIG_PIN, 0);

    int timeout_us = 30000;
    while (gpio_pin_get(gpio_dev, ECHO_PIN) == 0 && timeout_us-- > 0) {
        k_busy_wait(1);
    }
    if (timeout_us <= 0) {
        return -1.0f;
    }

    start_cycles = k_cycle_get_32();
    timeout_us = 30000;
    while (gpio_pin_get(gpio_dev, ECHO_PIN) == 1 && timeout_us-- > 0) {
        k_busy_wait(1);
    }
    if (timeout_us <= 0) {
        return -1.0f;
    }
    end_cycles = k_cycle_get_32();

    duration_us = k_cyc_to_us_floor64(end_cycles - start_cycles);
    return (float)duration_us / 58.0f;
}

static int compare_floats(const void *a, const void *b) {
    float fa = *(const float *)a;
    float fb = *(const float *)b;
    return (fa > fb) - (fa < fb);
}

static float read_distance_filtered_cm(void) {
    float samples[READINGS_PER_SAMPLE];
    int collected = 0;
    for (int i = 0; i < READINGS_PER_SAMPLE; i++) {
        float value = read_distance_once_cm();
        if (value > 0.0f) {
            samples[collected++] = value;
        }
        k_sleep(K_MSEC(50));
    }
    if (collected == 0) {
        return -1.0f;
    }
    qsort(samples, collected, sizeof(float), compare_floats);
    return samples[collected / 2];
}

static bool fill_sensor_reading(struct cached_reading *reading) {
    float distance = read_distance_filtered_cm();
    if (distance <= 0.0f) {
        return false;
    }
    reading->distance_cm = distance;
    reading->level_percent = 0.0f;
    reading->signal_rssi = -999;
    reading->signal_rsrp = get_signal_rsrp();
    return true;
}

static void button_pressed_handler(const struct device *dev, struct gpio_callback *cb, uint32_t pins) {
    ARG_UNUSED(dev);
    ARG_UNUSED(cb);
    ARG_UNUSED(pins);
    button_pressed = true;
}

static int connect_lte(void) {
    LOG_INF("Initializing modem library");
    int err = nrf_modem_lib_init();
    if (err) {
        LOG_ERR("Modem lib init failed: %d", err);
        return err;
    }
    LOG_INF("Modem library ready");

    err = lte_lc_system_mode_set(LTE_LC_SYSTEM_MODE_LTEM, LTE_LC_SYSTEM_MODE_PREFER_LTEM);
    if (err) {
        LOG_WRN("LTE mode set failed: %d", err);
    }

    LOG_INF("Connecting LTE");
    err = lte_lc_connect();
    if (err) {
        LOG_ERR("LTE connect failed: %d", err);
        return err;
    }
    LOG_INF("LTE connected");
    modem_info_init();
    return 0;
}

static int get_signal_rsrp(void) {
    int rsrp = 0;
    if (modem_info_get_rsrp(&rsrp) == 0) {
        return rsrp;
    }
    return -999;
}

static void process_sample(int *counter) {
    struct cached_reading reading;
    if (!fill_sensor_reading(&reading)) {
        LOG_WRN("Sensor reading failed");
        return;
    }
    (*counter)++;
    LOG_INF("Collected sample %d", *counter);
    if (send_reading(&reading) != 0) {
        cache_push(reading);
    } else {
        flush_cache();
    }
}

static int send_reading(const struct cached_reading *reading) {
    struct zsock_addrinfo *res;
    struct zsock_addrinfo hints = {
        .ai_family = AF_INET,
        .ai_socktype = SOCK_STREAM,
    };
    int distance_cm_i = (int)(reading->distance_cm + 0.5f);
    LOG_INF("Sending reading: distance=%d cm", distance_cm_i);
    int err = zsock_getaddrinfo(SERVER_HOST, SERVER_PORT, &hints, &res);
    if (err) {
        LOG_ERR("DNS failed: %d", err);
        return err;
    }

    int sock = zsock_socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (sock < 0) {
        zsock_freeaddrinfo(res);
        return -errno;
    }

    err = zsock_connect(sock, res->ai_addr, res->ai_addrlen);
    zsock_freeaddrinfo(res);
    if (err < 0) {
        zsock_close(sock);
        return -errno;
    }

    char payload[200];
    snprintk(
        payload,
        sizeof(payload),
        "{\"device_id\":\"tank-1\",\"api_key\":\"%s\",\"distance_cm\":%d,\"signal_rssi\":%d,\"signal_rsrp\":%d,\"fw_version\":\"%s\"}",
        API_KEY,
        distance_cm_i,
        reading->signal_rssi,
        reading->signal_rsrp,
        FW_VERSION
    );
    int payload_len = strlen(payload);

    char request[512];
    int req_len = snprintk(
        request,
        sizeof(request),
        "POST %s HTTP/1.1\r\n"
        "Host: %s\r\n"
        "Content-Type: application/json\r\n"
        "Content-Length: %d\r\n"
        "Connection: close\r\n"
        "\r\n"
        "%s",
        SERVER_PATH,
        SERVER_HOST,
        payload_len,
        payload
    );
    if (req_len <= 0 || req_len >= (int)sizeof(request)) {
        LOG_ERR("HTTP request build failed");
        zsock_close(sock);
        return -EINVAL;
    }

    err = zsock_send(sock, request, req_len, 0);
    if (err < 0) {
        LOG_ERR("HTTP send failed: %d", err);
    } else {
        LOG_INF("HTTP request sent");
    }

    struct zsock_timeval timeout = {
        .tv_sec = 5,
        .tv_usec = 0,
    };
    zsock_setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));

    char response[128];
    int received = zsock_recv(sock, response, sizeof(response) - 1, 0);
    if (received > 0) {
        response[received] = '\0';
        LOG_INF("HTTP response: %s", response);
    } else {
        LOG_WRN("No HTTP response (recv=%d)", received);
    }
    zsock_close(sock);
    return err;
}

static void flush_cache(void) {
    struct cached_reading reading;
    while (cache_peek(&reading)) {
        if (send_reading(&reading) == 0) {
            cache_pop(&reading);
        } else {
            break;
        }
    }
}

void main(void) {
    printk("Water tank monitor starting\r\n");
    LOG_INF("Water tank monitor starting");
    if (!device_is_ready(gpio_dev)) {
        LOG_ERR("GPIO device not ready");
        return;
    }
    gpio_pin_configure(gpio_dev, TRIG_PIN, GPIO_OUTPUT_INACTIVE);
    gpio_pin_configure(gpio_dev, ECHO_PIN, GPIO_INPUT | GPIO_PULL_DOWN);

    if (cache_init() != 0) {
        LOG_WRN("Flash cache unavailable; using RAM only");
    }

    if (!device_is_ready(led.port)) {
        LOG_ERR("LED device not ready");
        return;
    }
    gpio_pin_configure_dt(&led, GPIO_OUTPUT_INACTIVE);

    if (!device_is_ready(button.port)) {
        LOG_ERR("Button device not ready");
        return;
    }
    gpio_pin_configure_dt(&button, GPIO_INPUT);
    gpio_pin_interrupt_configure_dt(&button, GPIO_INT_EDGE_TO_ACTIVE);
    gpio_init_callback(&button_cb_data, button_pressed_handler, BIT(button.pin));
    gpio_add_callback(button.port, &button_cb_data);

    if (connect_lte() != 0) {
        LOG_WRN("Continuing without LTE; will cache readings");
    }

    int sample_counter = 0;
    int64_t interval_ms = SAMPLE_INTERVAL_MINUTES * 60 * 1000;
    int64_t next_sample_ms = k_uptime_get() + interval_ms;
    int64_t next_led_toggle_ms = k_uptime_get() + 500;
    bool led_on = false;
    while (true) {
        int64_t now = k_uptime_get();
        if (now >= next_led_toggle_ms) {
            led_on = !led_on;
            gpio_pin_set_dt(&led, led_on ? 1 : 0);
            next_led_toggle_ms = now + 500;
        }

        if (button_pressed) {
            button_pressed = false;
            LOG_INF("Button pressed: sending immediate sample");
            process_sample(&sample_counter);
            next_sample_ms = now + interval_ms;
        }

        if (now >= next_sample_ms) {
            process_sample(&sample_counter);
            next_sample_ms = now + interval_ms;
        }

        k_sleep(K_MSEC(50));
    }
}
