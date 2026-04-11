import os
from typing import List, Optional

import huggingface_hub
import torch
import yaml
from toolkit.config_modules import GenerateImageConfig, ModelConfig, NetworkConfig
from toolkit.lora_special import LoRASpecialNetwork
from toolkit.models.base_model import BaseModel
from toolkit.basic import flush
from toolkit.prompt_utils import PromptEmbeds
from toolkit.samplers.custom_flowmatch_sampler import (
    CustomFlowMatchEulerDiscreteScheduler,
)
from toolkit.accelerator import unwrap_model
from optimum.quanto import freeze
from toolkit.util.quantize import quantize, get_qtype, quantize_model
from toolkit.memory_management import MemoryManager # 이미 import 중
from safetensors.torch import load_file

from transformers import AutoTokenizer, Qwen3ForCausalLM
from diffusers import AutoencoderKL
from tqdm import tqdm
#region 추가
import gc
import traceback
import random
#endregion

try:
    from diffusers import ZImagePipeline
    from diffusers.models.transformers import ZImageTransformer2DModel
except ImportError:
    raise ImportError(
        "Diffusers is out of date. Update diffusers to the latest version by doing pip uninstall diffusers and then pip install -r requirements.txt"
    )

#region 추가
class FakeTransformer(torch.nn.Module):
    def __init__(self, device, dtype):
        super().__init__()
        self.dummy_param = torch.nn.Parameter(torch.zeros(1))
        self._device = torch.device(device)
        self._dtype = dtype

    @property
    def device(self):
        return self._device

    @property
    def dtype(self):
        return self._dtype

    def to(self, *args, **kwargs):
        if len(args) > 0:
            try:
                self._device = torch.device(args[0])
            except Exception:
                pass
        if "device" in kwargs and kwargs["device"] is not None:
            self._device = torch.device(kwargs["device"])
        if "dtype" in kwargs and kwargs["dtype"] is not None:
            self._dtype = kwargs["dtype"]
        return self

    def forward(self, *args, **kwargs):
        raise NotImplementedError("FakeTransformer should never be used for forward pass.")
    
FakeTextEncoder = FakeTransformer
#endregion


scheduler_config = {
    "num_train_timesteps": 1000,
    "use_dynamic_shifting": False,
    "shift": 3.0,
}


class ZImageModel(BaseModel):
    arch = "zimage"

    def __init__(
        self,
        device,
        model_config: ModelConfig,
        dtype="bf16",
        custom_pipeline=None,
        noise_scheduler=None,
        **kwargs,
    ):
        super().__init__(
            device, model_config, dtype, custom_pipeline, noise_scheduler, **kwargs
        )
        self.is_flow_matching = True
        self.is_transformer = True
        self.target_lora_modules = ["ZImageTransformer2DModel"]
    
    #region helper 추가
    def _resolve_paths(self):
        model_path = self.model_config.name_or_path
        base_model_path = self.model_config.extras_name_or_path

        transformer_path = model_path
        transformer_subfolder = "transformer"

        if os.path.exists(transformer_path):
            transformer_subfolder = None
            transformer_path = os.path.join(transformer_path, "transformer")
            te_folder_path = os.path.join(model_path, "text_encoder")
            if os.path.exists(te_folder_path):
                base_model_path = model_path

        return model_path, base_model_path, transformer_path, transformer_subfolder


    def _get_load_cfg(self):
        load_cfg = self.model_config.model_kwargs or {}
        load_offload_dir = load_cfg.get("load_offload_dir", "/content/aitk_load_offload")
        os.makedirs(load_offload_dir, exist_ok=True)
        return load_cfg, load_offload_dir
    
    def _move_tree_to_cpu(self, obj):
        if torch.is_tensor(obj):
            return obj.detach().to("cpu")
        if isinstance(obj, list):
            return [self._move_tree_to_cpu(x) for x in obj]
        if isinstance(obj, tuple):
            return tuple(self._move_tree_to_cpu(x) for x in obj)
        if isinstance(obj, dict):
            return {k: self._move_tree_to_cpu(v) for k, v in obj.items()}
        return obj
    #endregion
    #region 로더 추가
    def load_cache_models(self):
        dtype = self.torch_dtype
        load_cfg, load_offload_dir = self._get_load_cfg()
        _, base_model_path, _, _ = self._resolve_paths()

        self.print_and_status_update("Loading ZImage cache models")

        tokenizer = AutoTokenizer.from_pretrained(
            base_model_path,
            subfolder="tokenizer",
            torch_dtype=dtype,
        )

        te_load_kwargs = {
            "torch_dtype": dtype,
            "offload_state_dict": load_cfg.get("offload_state_dict", True),
            "offload_folder": os.path.join(load_offload_dir, "text_encoder"),
            "low_cpu_mem_usage": load_cfg.get("te_low_cpu_mem_usage", True),
        }

        text_encoder = Qwen3ForCausalLM.from_pretrained(
            base_model_path,
            subfolder="text_encoder",
            **te_load_kwargs,
        )

        vae = AutoencoderKL.from_pretrained(
            base_model_path,
            subfolder="vae",
            torch_dtype=dtype,
        )

        self.noise_scheduler = ZImageModel.get_train_scheduler()

        pipe = ZImagePipeline(
            scheduler=self.noise_scheduler,
            text_encoder=None,
            tokenizer=tokenizer,
            vae=vae,
            transformer=None,
        )

        pipe.text_encoder = text_encoder
        pipe.transformer = FakeTransformer(self.device_torch, self.torch_dtype)

        text_encoder.requires_grad_(False)
        text_encoder.eval()
        text_encoder.to("cpu")

        self.vae = vae
        self.text_encoder = [pipe.text_encoder]
        self.tokenizer = [pipe.tokenizer]
        self.model = pipe.transformer
        self.pipeline = pipe

        self.print_and_status_update("Cache models loaded")
        flush()
    def load_transformer_for_training(self):
        dtype = self.torch_dtype
        load_cfg, load_offload_dir = self._get_load_cfg()
        _, _, transformer_path, transformer_subfolder = self._resolve_paths()

        self.print_and_status_update("Loading transformer for training")

        transformer_load_kwargs = {
            "torch_dtype": dtype,
            "offload_state_dict": load_cfg.get("offload_state_dict", True),
            "offload_folder": os.path.join(load_offload_dir, "transformer"),
            "low_cpu_mem_usage": load_cfg.get("transformer_low_cpu_mem_usage", False),
        }

        transformer = ZImageTransformer2DModel.from_pretrained(
            transformer_path,
            subfolder=transformer_subfolder,
            **transformer_load_kwargs,
        )

        if self.model_config.assistant_lora_path is not None:
            self.load_training_adapter(transformer)
            if self.model_config.qtype == "qfloat8":
                self.model_config.qtype = "float8"

        if self.model_config.quantize:
            self.print_and_status_update("Quantizing Transformer")
            quantize_model(self, transformer)
            flush()
        
        #region 변경
        if (
            self.model_config.layer_offloading
            and self.model_config.layer_offloading_transformer_percent > 0
        ):
            mm_seed = int(load_cfg.get("memory_manager_seed", 1337))
            self.print_and_status_update(
                f"Attaching MemoryManager to transformer ({self.model_config.layer_offloading_transformer_percent:.2f}, seed={mm_seed})"
            )

            prev_random_state = random.getstate()
            try:
                random.seed(mm_seed)
                MemoryManager.attach(
                    transformer,
                    self.device_torch,
                    offload_percent=self.model_config.layer_offloading_transformer_percent,
                    ignore_modules=[
                        transformer.x_pad_token,
                        transformer.cap_pad_token,
                    ],
                )
            finally:
                random.setstate(prev_random_state)

            flush()
        #endregion

        self.pipeline.transformer = transformer
        self.model = transformer

        self.print_and_status_update("Training transformer loaded")
        flush()
    #endregion
    #region 추가
    def _has_real_text_encoder(self):
        return (
            self.pipeline is not None
            and self.pipeline.text_encoder is not None
            and not isinstance(self.pipeline.text_encoder, FakeTextEncoder)
        )

    def ensure_text_encoder_loaded(self):
        print("DEBUG: ensure_text_encoder_loaded() called", flush=True)
        # traceback.print_stack(limit=12) # 불필요
        
        if self._has_real_text_encoder():
            return

        dtype = self.torch_dtype
        load_cfg, load_offload_dir = self._get_load_cfg()
        _, base_model_path, _, _ = self._resolve_paths()

        te_load_kwargs = {
            "torch_dtype": dtype,
            "offload_state_dict": load_cfg.get("offload_state_dict", True),
            "offload_folder": os.path.join(load_offload_dir, "text_encoder"),
            "low_cpu_mem_usage": load_cfg.get("te_low_cpu_mem_usage", True),
        }

        text_encoder = Qwen3ForCausalLM.from_pretrained(
            base_model_path,
            subfolder="text_encoder",
            **te_load_kwargs,
        )

        text_encoder.requires_grad_(False)
        text_encoder.eval()
        text_encoder.to("cpu")

        self.pipeline.text_encoder = text_encoder
        self.text_encoder = [text_encoder]
        flush()

    def unload_text_encoder_after_cache(self):
        if not self._has_real_text_encoder():
            return

        self.print_and_status_update("Unloading text encoder after cache")

        old_te = self.pipeline.text_encoder
        try:
            old_te.to("cpu")
        except Exception:
            pass

        self.pipeline.text_encoder = FakeTextEncoder(self.device_torch, self.torch_dtype)
        self.text_encoder = [self.pipeline.text_encoder]

        del old_te
        gc.collect()
        flush()
    #endregion

    # static method to get the noise scheduler
    @staticmethod
    def get_train_scheduler():
        return CustomFlowMatchEulerDiscreteScheduler(**scheduler_config)

    def get_bucket_divisibility(self):
        return 16 * 2  # 16 for the VAE, 2 for patch size

    def load_training_adapter(self, transformer: ZImageTransformer2DModel):
        self.print_and_status_update("Loading assistant LoRA")
        lora_path = self.model_config.assistant_lora_path
        if not os.path.exists(lora_path):
            # assume it is a hub path
            lora_splits = lora_path.split("/")
            if len(lora_splits) != 3:
                raise ValueError(
                    f"Assistant LoRA path {lora_path} is not a valid local path or hub path."
                )
            repo_id = "/".join(lora_splits[:2])
            filename = lora_splits[2]
            try:
                lora_path = huggingface_hub.hf_hub_download(
                    repo_id=repo_id,
                    filename=filename,
                )
                # upgrade path to
                self.model_config.assistant_lora_path = lora_path
            except Exception as e:
                raise ValueError(
                    f"Failed to download assistant LoRA from {lora_path}: {e}"
                )
        # load the adapter and merge it in. We will inference with a -1.0 multiplier so the adapter effects only work during training.
        lora_state_dict = load_file(lora_path)
        dim = int(
            lora_state_dict[
                "diffusion_model.layers.0.attention.to_k.lora_A.weight"
            ].shape[0]
        )

        new_sd = {}
        for key, value in lora_state_dict.items():
            new_key = key.replace("diffusion_model.", "transformer.")
            new_sd[new_key] = value
        lora_state_dict = new_sd

        network_config = {
            "type": "lora",
            "linear": dim,
            "linear_alpha": dim,
            "transformer_only": True,
        }

        network_config = NetworkConfig(**network_config)
        LoRASpecialNetwork.LORA_PREFIX_UNET = "lora_transformer"
        network = LoRASpecialNetwork(
            text_encoder=None,
            unet=transformer,
            lora_dim=network_config.linear,
            multiplier=1.0,
            alpha=network_config.linear_alpha,
            train_unet=True,
            train_text_encoder=False,
            network_config=network_config,
            network_type=network_config.type,
            transformer_only=network_config.transformer_only,
            is_transformer=True,
            target_lin_modules=self.target_lora_modules,
            is_assistant_adapter=True,
            is_ara=True,
        )
        network.apply_to(None, transformer, apply_text_encoder=False, apply_unet=True)
        self.print_and_status_update("Merging in assistant LoRA")
        network.force_to(self.device_torch, dtype=self.torch_dtype)
        network._update_torch_multiplier()
        network.load_weights(lora_state_dict)

        network.merge_in(merge_weight=1.0)

        # mark it as not merged so inference ignores it.
        network.is_merged_in = False

        # add the assistant so sampler will activate it while sampling
        self.assistant_lora: LoRASpecialNetwork = network

        # deactivate lora during training
        self.assistant_lora.multiplier = -1.0
        self.assistant_lora.is_active = False

        # tell the model to invert assistant on inference since we want remove lora effects
        self.invert_assistant_lora = True

    def load_transformer_for_sampling(self):
        dtype = self.torch_dtype
        load_cfg, load_offload_dir = self._get_load_cfg()
        _, _, transformer_path, transformer_subfolder = self._resolve_paths()

        self.print_and_status_update("Loading transformer for sampling")

        transformer = ZImageTransformer2DModel.from_pretrained(
            transformer_path,
            subfolder=transformer_subfolder,
            torch_dtype=dtype,
            offload_state_dict=load_cfg.get("offload_state_dict", True),
            offload_folder=os.path.join(load_offload_dir, "transformer_sampling"),
            low_cpu_mem_usage=False,
        )

        if self.model_config.quantize:
            self.print_and_status_update("Quantizing sampling transformer")
            quantize_model(self, transformer)
            flush()

        transformer.to(self.device_torch, dtype=dtype)
        transformer.eval()
        transformer.requires_grad_(False)
        flush()
        return transformer

    def _can_use_fast_sampling(self, image_configs, sampler=None, pipeline=None):
        if pipeline is not None or sampler is not None:
            return False
        if self.network is None:
            return False
        if self.adapter is not None or self.refiner_unet is not None:
            return False
        if self.model_config.assistant_lora_path is not None or self.model_config.inference_lora_path is not None:
            return False
        if self.sample_prompts_cache is None:
            return False
        if len(image_configs) == 0:
            return False
        unique_network_weights = set([x.network_multiplier for x in image_configs])
        if len(unique_network_weights) != 1:
            return False
        return True

    def _create_sampling_network(self, transformer, merge_multiplier: float):
        if self.network is None:
            return None

        base_network = unwrap_model(self.network)
        alpha = getattr(base_network, "alpha", None)
        if torch.is_tensor(alpha):
            alpha = alpha.detach().float().item()

        network = LoRASpecialNetwork(
            text_encoder=None,
            unet=transformer,
            lora_dim=base_network.lora_dim,
            multiplier=merge_multiplier,
            alpha=alpha,
            train_unet=True,
            train_text_encoder=False,
            network_config=getattr(base_network, "network_config", None),
            network_type=getattr(base_network, "network_type", "lora"),
            transformer_only=getattr(base_network, "transformer_only", True),
            is_transformer=True,
            target_lin_modules=self.target_lora_modules,
            is_ara=getattr(base_network, "is_ara", False),
            base_model=self,
        )
        network.apply_to(None, transformer, apply_text_encoder=False, apply_unet=True)
        network.force_to(self.device_torch, dtype=torch.float32)
        network.load_weights(base_network.state_dict())

        if network.can_merge_in:
            network.merge_in(merge_weight=merge_multiplier)
            network.force_to("cpu", dtype=torch.float32)
            flush()

        return network

    def _get_cached_sample_prompt_embeds(self, idx: int):
        cache_item = self.sample_prompts_cache[idx]
        if "conditional_path" in cache_item:
            conditional_embeds = PromptEmbeds.load(cache_item["conditional_path"])
            unconditional_embeds = PromptEmbeds.load(cache_item["unconditional_path"])
        else:
            conditional_embeds = cache_item["conditional"]
            unconditional_embeds = cache_item["unconditional"]
        return conditional_embeds, unconditional_embeds

        # 전체 변경
    def load_model(self, cache_only=False):
        self.load_cache_models()
        if not cache_only:
            self.load_transformer_for_training()
            self.print_and_status_update("Model Loaded")

    def get_generation_pipeline(self):
        scheduler = ZImageModel.get_train_scheduler()

        te_for_pipeline = None
        if self.sample_prompts_cache is None:
            self.ensure_text_encoder_loaded()
            te_for_pipeline = unwrap_model(self.text_encoder[0])
        elif self._has_real_text_encoder():
            te_for_pipeline = unwrap_model(self.text_encoder[0])

        pipeline: ZImagePipeline = ZImagePipeline(
            scheduler=scheduler,
            text_encoder=te_for_pipeline,
            tokenizer=self.tokenizer[0],
            vae=unwrap_model(self.vae),
            transformer=unwrap_model(self.transformer),
        )

        return pipeline

    @torch.no_grad()
    def generate_images(
        self,
        image_configs: List[GenerateImageConfig],
        sampler=None,
        pipeline=None,
    ):
        if not self._can_use_fast_sampling(image_configs, sampler=sampler, pipeline=pipeline):
            return super().generate_images(image_configs, sampler=sampler, pipeline=pipeline)

        merge_multiplier = image_configs[0].network_multiplier
        self.print_and_status_update("Generating ZImage samples with dedicated inference transformer")

        rng_state = torch.get_rng_state()
        cuda_rng_state = torch.cuda.get_rng_state() if torch.cuda.is_available() else None

        self.save_device_state()

        sampling_transformer = None
        sampling_network = None
        sampling_pipeline = None

        try:
            try:
                self.unet.to("cpu")
            except Exception:
                pass

            if self.network is not None:
                try:
                    self.network.force_to("cpu", dtype=torch.float32)
                    if hasattr(self.network, "_update_torch_multiplier"):
                        self.network._update_torch_multiplier()
                except Exception:
                    pass

            gc.collect()
            torch.cuda.empty_cache()
            flush()

            self.vae.to(self.device_torch, dtype=self.vae_torch_dtype)
            self.vae.eval()
            self.vae.requires_grad_(False)

            sampling_transformer = self.load_transformer_for_sampling()
            sampling_network = self._create_sampling_network(
                sampling_transformer,
                merge_multiplier,
            )

            scheduler = ZImageModel.get_train_scheduler()
            te_for_pipeline = None
            if self.sample_prompts_cache is None:
                self.ensure_text_encoder_loaded()
                te_for_pipeline = unwrap_model(self.text_encoder[0])
            elif self._has_real_text_encoder():
                te_for_pipeline = unwrap_model(self.text_encoder[0])

            sampling_pipeline = ZImagePipeline(
                scheduler=scheduler,
                text_encoder=te_for_pipeline,
                tokenizer=self.tokenizer[0],
                vae=unwrap_model(self.vae),
                transformer=sampling_transformer,
            )

            try:
                sampling_pipeline.set_progress_bar_config(disable=True)
            except Exception:
                pass

            for i in tqdm(range(len(image_configs)), desc="Generating Images", leave=False):
                gen_config = image_configs[i]
                conditional_embeds, unconditional_embeds = self._get_cached_sample_prompt_embeds(i)

                gen_config.post_process_embeddings(
                    conditional_embeds,
                    unconditional_embeds,
                )

                if self.decorator is not None:
                    conditional_embeds.text_embeds = self.decorator(
                        conditional_embeds.text_embeds
                    )
                    unconditional_embeds.text_embeds = self.decorator(
                        unconditional_embeds.text_embeds,
                        is_unconditional=True,
                    )

                conditional_embeds = conditional_embeds.to(
                    self.device_torch, dtype=self.unet.dtype
                )
                unconditional_embeds = unconditional_embeds.to(
                    self.device_torch, dtype=self.unet.dtype
                )

                torch.manual_seed(gen_config.seed)
                if torch.cuda.is_available():
                    torch.cuda.manual_seed(gen_config.seed)
                generator = torch.manual_seed(gen_config.seed)

                img = self.generate_single_image(
                    sampling_pipeline,
                    gen_config,
                    conditional_embeds,
                    unconditional_embeds,
                    generator,
                    {},
                )

                gen_config.save_image(img, i)
                gen_config.log_image(img, i)
                self._after_sample_image(i, len(image_configs))

                del conditional_embeds, unconditional_embeds, img
                flush()

        finally:
            if sampling_pipeline is not None:
                del sampling_pipeline
            if sampling_network is not None:
                del sampling_network
            if sampling_transformer is not None:
                del sampling_transformer

            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

            torch.set_rng_state(rng_state)
            if cuda_rng_state is not None:
                torch.cuda.set_rng_state(cuda_rng_state)

            self.restore_device_state()
            flush()

    def generate_single_image(
        self,
        pipeline: ZImagePipeline,
        gen_config: GenerateImageConfig,
        conditional_embeds: PromptEmbeds,
        unconditional_embeds: PromptEmbeds,
        generator: torch.Generator,
        extra: dict,
    ):
        sc = self.get_bucket_divisibility()
        gen_config.width = int(gen_config.width // sc * sc)
        gen_config.height = int(gen_config.height // sc * sc)

        img = pipeline(
            prompt_embeds=conditional_embeds.text_embeds,
            negative_prompt_embeds=unconditional_embeds.text_embeds,
            height=gen_config.height,
            width=gen_config.width,
            num_inference_steps=gen_config.num_inference_steps,
            guidance_scale=gen_config.guidance_scale,
            latents=gen_config.latents,
            generator=generator,
            **extra,
        ).images[0]
        return img

    def get_noise_prediction(
        self,
        latent_model_input: torch.Tensor,
        timestep: torch.Tensor,  # 0 to 1000 scale
        text_embeddings: PromptEmbeds,
        **kwargs,
    ):
        self.model.to(self.device_torch)

        latent_model_input = latent_model_input.unsqueeze(2)
        latent_model_input_list = list(latent_model_input.unbind(dim=0))

        timestep_model_input = (1000 - timestep) / 1000

        model_out_list = self.transformer(
            latent_model_input_list,
            timestep_model_input,
            text_embeddings.text_embeds,
        )[0]

        noise_pred = torch.stack([t.float() for t in model_out_list], dim=0)

        noise_pred = noise_pred.squeeze(2)
        noise_pred = -noise_pred

        return noise_pred

    #region 교체
    # def get_prompt_embeds(self, prompt: str) -> PromptEmbeds:
    #     if self.pipeline.text_encoder.device != self.device_torch:
    #         self.pipeline.text_encoder.to(self.device_torch)

    #     prompt_embeds, _ = self.pipeline.encode_prompt(
    #         prompt,
    #         do_classifier_free_guidance=False,
    #         device=self.device_torch,
    #     )
    #     pe = PromptEmbeds([prompt_embeds, None])
    #     return pe
    # 교체 v4
    def _has_real_transformer(self):
        return self.pipeline is not None and self.pipeline.transformer is not None and not isinstance(self.pipeline.transformer, FakeTransformer)

    def get_prompt_embeds(self, prompt: str) -> PromptEmbeds:
        self.ensure_text_encoder_loaded() # 추가 v5
        
        if self._has_real_transformer() and self.pipeline.transformer.device == self.device_torch:
            self.pipeline.transformer.to("cpu")
            flush()

        if self.pipeline.text_encoder.device != self.device_torch:
            self.pipeline.text_encoder.to(self.device_torch)
            flush()

        prompt_embeds, _ = self.pipeline.encode_prompt(
            prompt,
            do_classifier_free_guidance=False,
            device=self.device_torch,
        )

        prompt_embeds = self._move_tree_to_cpu(prompt_embeds)

        self.pipeline.text_encoder.to("cpu")
        flush()

        pe = PromptEmbeds([prompt_embeds, None])
        return pe
    #endregion

    def get_model_has_grad(self):
        return False

    def get_te_has_grad(self):
        return False

    def save_model(self, output_path, meta, save_dtype):
        transformer: ZImageTransformer2DModel = unwrap_model(self.model)
        transformer.save_pretrained(
            save_directory=os.path.join(output_path, "transformer"),
            safe_serialization=True,
        )

        meta_path = os.path.join(output_path, "aitk_meta.yaml")
        with open(meta_path, "w") as f:
            yaml.dump(meta, f)

    def get_loss_target(self, *args, **kwargs):
        noise = kwargs.get("noise")
        batch = kwargs.get("batch")
        return (noise - batch.latents).detach()

    def get_base_model_version(self):
        return "zimage"

    def get_transformer_block_names(self) -> Optional[List[str]]:
        return ["layers"]

    def convert_lora_weights_before_save(self, state_dict):
        new_sd = {}
        for key, value in state_dict.items():
            new_key = key.replace("transformer.", "diffusion_model.")
            new_sd[new_key] = value
        return new_sd

    def convert_lora_weights_before_load(self, state_dict):
        new_sd = {}
        for key, value in state_dict.items():
            new_key = key.replace("diffusion_model.", "transformer.")
            new_sd[new_key] = value
        return new_sd
